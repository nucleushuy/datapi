import { pathToFileURL } from "node:url";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "../../coding-agent/src/core/auth-storage.ts";
import { ASSISTANT_OUTPUT_BYTES, type AssistantUsage } from "./assistant-contracts.ts";
import type { ASSISTANT_WORKER_ERRORS } from "./assistant-driver.ts";
import {
	ASSISTANT_PROVIDERS,
	ASSISTANT_REQUEST_BYTES,
	isAssistantApiKey,
	isAssistantUsage,
} from "./assistant-driver.ts";
import { CHART_TYPES } from "./chart-contracts.ts";
import { parseChartProposal } from "./conversation-chart.ts";
import type { ConversationDriver, ConversationDriverEvent } from "./conversation-contracts.ts";
import {
	CONVERSATION_PROPOSAL_LIMIT,
	type RenameProposalValidator,
	renameProposalValidator,
} from "./conversation-driver.ts";

const VIRTUAL_CWD = process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant";
const SYSTEM_SUFFIX = `\nCurrent working directory: ${VIRTUAL_CWD}\n`;

const nullableColumn = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
// Public Type schema for Pi's tool protocol; parseChartProposal remains the semantic authority.
const chartParameters = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 120 }),
		explanation: Type.String({ minLength: 1, maxLength: 4000 }),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		evidenceRefs: Type.Array(Type.String(), { maxItems: 32, uniqueItems: true }),
		affectedColumns: Type.Array(Type.Integer({ minimum: 0 }), { maxItems: 32, uniqueItems: true }),
		spec: Type.Object(
			{
				version: Type.Literal(1),
				datasetVersionId: Type.String({ minLength: 1, maxLength: 80 }),
				type: Type.Union(CHART_TYPES.map((type) => Type.Literal(type))),
				x: nullableColumn,
				y: nullableColumn,
				color: nullableColumn,
				size: nullableColumn,
				facet: nullableColumn,
				aggregation: Type.Union([
					Type.Literal("count"),
					Type.Literal("sum"),
					Type.Literal("mean"),
					Type.Literal("median"),
					Type.Literal("none"),
				]),
				sort: Type.Union([Type.Literal("ascending"), Type.Literal("descending"), Type.Literal("value-descending")]),
				filters: Type.Array(
					Type.Object(
						{
							column: Type.Integer({ minimum: 0 }),
							op: Type.Union(
								["eq", "neq", "contains", "gt", "gte", "lt", "lte", "is-null", "not-null"].map((op) =>
									Type.Literal(op),
								),
							),
							value: Type.String({ maxLength: 512 }),
						},
						{ additionalProperties: false },
					),
					{ maxItems: 8 },
				),
				bins: Type.Integer({ minimum: 5, maximum: 100 }),
				categoryLimit: Type.Integer({ minimum: 1, maximum: 30 }),
				zeroBaseline: Type.Boolean(),
				xMin: nullableNumber,
				yMin: nullableNumber,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

type Request = Parameters<ConversationDriver["chat"]>[0] & { authPath: string };
class WorkerFailure extends Error {}
function fail(code: keyof typeof ASSISTANT_WORKER_ERRORS): never {
	throw new WorkerFailure(code);
}
function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function path(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}
function request(value: unknown): Request {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("request");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !==
			7 + Number(Object.hasOwn(input, "renameScope")) + Number(Object.hasOwn(input, "chartScope")) ||
		!path(input.authPath) ||
		typeof input.provider !== "string" ||
		!ASSISTANT_PROVIDERS.has(input.provider) ||
		typeof input.modelId !== "string" ||
		input.modelId.length === 0 ||
		input.modelId.length > 256 ||
		!path(input.sessionDir) ||
		(input.sessionFile !== null && !path(input.sessionFile)) ||
		typeof input.system !== "string" ||
		typeof input.user !== "string" ||
		input.user.length === 0 ||
		(Object.hasOwn(input, "renameScope") && input.renameScope === undefined) ||
		(Object.hasOwn(input, "chartScope") &&
			(typeof input.chartScope !== "object" || input.chartScope === null || Array.isArray(input.chartScope))) ||
		Buffer.byteLength(JSON.stringify(input)) > ASSISTANT_REQUEST_BYTES
	)
		fail("request");
	if (!input.system.endsWith(SYSTEM_SUFFIX) || input.system.length === SYSTEM_SUFFIX.length) fail("context");
	return {
		authPath: input.authPath,
		provider: input.provider,
		modelId: input.modelId,
		sessionFile: input.sessionFile as string | null,
		sessionDir: input.sessionDir,
		system: input.system,
		user: input.user,
		...(Object.hasOwn(input, "renameScope") ? { renameScope: input.renameScope as Request["renameScope"] } : {}),
		...(Object.hasOwn(input, "chartScope") ? { chartScope: input.chartScope as Request["chartScope"] } : {}),
	};
}

/** Runs an isolated Pi session with only scoped, non-executing proposal tools when granted. */
export async function runConversationSession(
	value: unknown,
	onEvent: Parameters<ConversationDriver["chat"]>[1],
	signal?: AbortSignal,
	runtime?: ModelRuntime,
): Promise<{ text: string; usage: AssistantUsage; sessionFile: string }> {
	const input = request(value);
	let validateProposal: RenameProposalValidator | undefined;
	try {
		validateProposal = renameProposalValidator(input.renameScope);
	} catch {
		fail("request");
	}
	const proposals = new Map<
		string,
		{ event: Exclude<ConversationDriverEvent, { type: "text" }>; arguments: string }
	>();
	const emitted = new Set<string>();
	const executeProposal = async (toolCallId: string, params: unknown, toolSignal?: AbortSignal) => {
		if (signal?.aborted || toolSignal?.aborted) fail("cancelled");
		if (failure) throw failure;
		const proposal = proposals.get(toolCallId);
		if (!proposal || emitted.has(toolCallId) || proposal.arguments !== JSON.stringify(params)) {
			stop("protocol");
			fail("protocol");
		}
		emitted.add(toolCallId);
		try {
			onEvent(proposal.event);
		} catch {
			stop("protocol");
			fail("protocol");
		}
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify({ status: "awaiting_review", toolCallId, applied: false }) },
			],
			details: undefined,
		};
	};
	const customTools = [
		...(validateProposal
			? [
					defineTool({
						name: "propose_column_rename",
						label: "Propose column rename",
						description:
							"Propose a rename of one disclosed column in the frozen dataset version. Await local review, preview and explicit approval; this tool does not apply a change or execute SQL.",
						parameters: Type.Object(
							{
								column: Type.Integer({ minimum: 0 }),
								name: Type.String({ minLength: 1, maxLength: 256 }),
								datasetVersionId: Type.String({ minLength: 1, maxLength: 80 }),
							},
							{ additionalProperties: false },
						),
						execute: executeProposal,
					}),
				]
			: []),
		...(input.chartScope
			? [
					defineTool({
						name: "propose_chart",
						label: "Propose chart",
						description:
							"Propose a chart specification and evidence-based explanation using only the frozen dataset version and disclosed columns. This tool does not compute a preview, create a chart, run code, or mutate data. Await local preview and explicit save or reject.",
						parameters: chartParameters,
						execute: executeProposal,
					}),
				]
			: []),
	];
	if (signal?.aborted) fail("cancelled");
	// Read the stored literal value, never Pi's executable/environment credential resolver.
	const credential = readStoredCredential(input.provider, input.authPath);
	if (credential?.type !== "api_key" || !isAssistantApiKey(credential.key)) fail("credentials");
	if (!runtime) {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(input.provider, async () => ({ type: "api_key", key: credential.key }));
		runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
	}
	const model = runtime.getModel(input.provider, input.modelId);
	if (model === undefined) fail("model");
	const resources = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	// Publish only a successful turn's file; failures must not alter the last committed transcript.
	const manager = input.sessionFile
		? SessionManager.forkFrom(input.sessionFile, VIRTUAL_CWD, input.sessionDir)
		: SessionManager.create(VIRTUAL_CWD, input.sessionDir);
	const { session } = await createAgentSession({
		cwd: VIRTUAL_CWD,
		agentDir: VIRTUAL_CWD,
		modelRuntime: runtime,
		model: { ...model, maxTokens: Math.min(model.maxTokens, 8192) },
		thinkingLevel: "off",
		tools: customTools.map((tool) => tool.name),
		customTools,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } },
			enableAnalytics: false,
			enableInstallTelemetry: false,
			enableSkillCommands: false,
			transport: "sse",
		}),
		resourceLoader: {
			getExtensions: () => resources,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => input.system.slice(0, -SYSTEM_SUFFIX.length),
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		},
	});
	let text = "";
	let bytes = 0;
	let messageText = "";
	let final = false;
	const usage: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	let failure: WorkerFailure | undefined;
	const stop = (code: keyof typeof ASSISTANT_WORKER_ERRORS) => {
		failure ??= new WorkerFailure(code);
		void session.abort().catch(() => {});
	};
	const abort = () => stop("cancelled");
	signal?.addEventListener("abort", abort, { once: true });
	const unsubscribe = session.subscribe((event) => {
		if (failure) return;
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			if (final) return stop("protocol");
			const delta = event.assistantMessageEvent.delta;
			bytes += Buffer.byteLength(delta);
			if (bytes > ASSISTANT_OUTPUT_BYTES) return stop("output");
			text += delta;
			messageText += delta;
			try {
				onEvent({ type: "text", delta });
			} catch {
				stop("protocol");
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			if (final || (message.stopReason !== "stop" && message.stopReason !== "toolUse")) {
				stop(message.stopReason === "length" ? "output" : "provider");
				return;
			}
			let finalText = "";
			let calls = 0;
			for (const content of message.content) {
				if (content.type === "text") finalText += content.text;
				else if (content.type === "toolCall") {
					if (message.stopReason !== "toolUse") return stop("protocol");
					const args = content.arguments;
					if (!args || typeof args !== "object" || Array.isArray(args)) return stop("protocol");
					if (proposals.has(content.id)) return stop("protocol");
					if (proposals.size >= CONVERSATION_PROPOSAL_LIMIT) return stop("output");
					const value = { ...args, toolCallId: content.id };
					let proposal: Exclude<ConversationDriverEvent, { type: "text" }>;
					// Inspect the original tool arguments before Pi can coerce or strip fields.
					if (content.name === "propose_column_rename" && validateProposal) {
						if (Object.keys(args).length !== 3 || !validateProposal(value)) return stop("protocol");
						proposal = { type: "rename_proposal", ...value };
					} else if (content.name === "propose_chart" && input.chartScope) {
						if (Object.keys(args).length !== 6) return stop("protocol");
						try {
							const { basis: _basis, ...parsed } = parseChartProposal(value, input.chartScope);
							proposal = { type: "chart_proposal", ...parsed };
						} catch {
							return stop("protocol");
						}
					} else return stop("protocol");
					bytes += Buffer.byteLength(JSON.stringify({ type: proposal.type, ...value }));
					if (bytes > ASSISTANT_OUTPUT_BYTES) return stop("output");
					proposals.set(content.id, { event: proposal, arguments: JSON.stringify(args) });
					calls++;
				} else if (content.type !== "thinking") return stop("protocol");
			}
			if (finalText !== messageText || (message.stopReason === "toolUse" && calls === 0)) return stop("protocol");
			messageText = "";
			const { input: inputTokens, output, cacheRead, cacheWrite, totalTokens } = message.usage;
			const counts = { input: inputTokens, output, cacheRead, cacheWrite, totalTokens };
			if (!isAssistantUsage(counts)) return stop("provider");
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				usage[key] += counts[key];
			if (!isAssistantUsage(usage)) return stop("output");
			final = message.stopReason === "stop";
		}
	});
	try {
		if (signal?.aborted) fail("cancelled");
		const activeTools = session.getActiveToolNames();
		if (
			session.systemPrompt !== input.system ||
			activeTools.length !== customTools.length ||
			customTools.some((tool) => !activeTools.includes(tool.name))
		)
			fail("context");
		await session.prompt(input.user, { expandPromptTemplates: false });
		await session.waitForIdle();
		if (failure) throw failure;
		if (!final || !text || proposals.size !== emitted.size) fail("provider");
		if (!session.sessionFile) fail("provider");
		return { text, usage, sessionFile: session.sessionFile };
	} catch (error) {
		throw failure ?? (error instanceof WorkerFailure ? error : new WorkerFailure("provider"));
	} finally {
		signal?.removeEventListener("abort", abort);
		unsubscribe();
		try {
			await session.abort();
		} finally {
			session.dispose();
		}
	}
}

async function readRequest(): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	try {
		for await (const chunk of process.stdin) {
			const part = Buffer.from(chunk);
			bytes += part.length;
			if (bytes > ASSISTANT_REQUEST_BYTES) fail("request");
			chunks.push(part);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
	} catch {
		fail("request");
	}
}
async function main(): Promise<void> {
	try {
		const result = await runConversationSession(await readRequest(), emit);
		emit({ type: "result", ...result });
	} catch (error) {
		emit({ type: "error", code: error instanceof WorkerFailure ? error.message : "provider" });
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
