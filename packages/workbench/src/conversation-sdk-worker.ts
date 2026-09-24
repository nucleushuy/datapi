import { pathToFileURL } from "node:url";
import { type AssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
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
import type { ConversationDriver } from "./conversation-contracts.ts";

const VIRTUAL_CWD = process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant";
const SYSTEM_SUFFIX = `\nCurrent working directory: ${VIRTUAL_CWD}\n`;

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
		Object.keys(input).length !== 7 ||
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
	};
}

/** Runs the fixed read-only Pi session; a supplied runtime changes only the provider transport. */
export async function runConversationSession(
	value: unknown,
	onText: Parameters<ConversationDriver["chat"]>[1],
	signal?: AbortSignal,
	runtime?: ModelRuntime,
): Promise<{ text: string; usage: AssistantUsage; sessionFile: string }> {
	const input = request(value);
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
	const manager = input.sessionFile
		? SessionManager.open(input.sessionFile, input.sessionDir, VIRTUAL_CWD)
		: SessionManager.create(VIRTUAL_CWD, input.sessionDir);
	const { session } = await createAgentSession({
		cwd: VIRTUAL_CWD,
		agentDir: VIRTUAL_CWD,
		modelRuntime: runtime,
		model: { ...model, maxTokens: Math.min(model.maxTokens, 8192) },
		thinkingLevel: "off",
		tools: [],
		customTools: [],
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
	let final: AssistantMessage | undefined;
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
			const delta = event.assistantMessageEvent.delta;
			bytes += Buffer.byteLength(delta);
			if (bytes > ASSISTANT_OUTPUT_BYTES) return stop("output");
			text += delta;
			try {
				onText({ type: "text", delta });
			} catch {
				stop("protocol");
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			if (final || event.message.stopReason !== "stop") {
				stop(event.message.stopReason === "length" ? "output" : "provider");
				return;
			}
			final = event.message;
		}
	});
	try {
		if (signal?.aborted) fail("cancelled");
		if (session.systemPrompt !== input.system || session.getActiveToolNames().length !== 0) fail("context");
		await session.prompt(input.user, { expandPromptTemplates: false });
		await session.waitForIdle();
		if (failure) throw failure;
		if (!final || !text) fail("provider");
		let finalText = "";
		for (const content of final.content) {
			if (content.type === "text") finalText += content.text;
			else if (content.type !== "thinking") fail("provider");
		}
		if (finalText !== text) fail("protocol");
		const { input: inputTokens, output, cacheRead, cacheWrite, totalTokens } = final.usage;
		const usage = { input: inputTokens, output, cacheRead, cacheWrite, totalTokens };
		if (!isAssistantUsage(usage) || !session.sessionFile) fail("provider");
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
