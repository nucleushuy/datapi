import { getCurrentSystemPrompt, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, defineTool, type SessionManager } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_OUTPUT_BYTES, type AssistantUsage } from "./assistant-contracts.ts";
import { ASSISTANT_REQUEST_BYTES, ASSISTANT_WORKER_ERRORS, isAssistantUsage } from "./assistant-driver.ts";
import { CHART_TYPES } from "./chart-contracts.ts";
import { parseChartProposal } from "./conversation-chart.ts";
import { CONVERSATION_REASONING_EFFORTS, CONVERSATION_REQUEST_BYTES, type ConversationDriver, type ConversationDriverEvent, type ConversationDriverInput } from "./conversation-contracts.ts";
import { CONVERSATION_PROPOSAL_LIMIT, type RenameProposalValidator, renameProposalValidator } from "./conversation-driver.ts";
import { parseConversationScreenshots } from "./conversation-screenshots.ts";
import { CONVERSATION_CWD } from "./conversation-session.ts";
import type { ProviderService } from "./provider-service.ts";
import type { SessionModelState } from "./provider-contracts.ts";

const SYSTEM_SUFFIX = `\nCurrent working directory: ${CONVERSATION_CWD}\n`;

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

type Request = ConversationDriverInput;
export class ConversationRuntimeFailure extends Error {}
function fail(code: keyof typeof ASSISTANT_WORKER_ERRORS): never {
	throw new ConversationRuntimeFailure(code);
}
function path(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}
export function conversationRequest(value: unknown): Request {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("request");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !==
			6 +
				["conversationId", "renameScope", "chartScope", "mode", "reasoningEffort", "images"].filter((key) =>
					Object.hasOwn(input, key),
				).length ||
		typeof input.provider !== "string" ||
		!input.provider.length || input.provider.length > 128 ||
		(Object.hasOwn(input, "conversationId") && !path(input.conversationId)) ||
		typeof input.modelId !== "string" ||
		input.modelId.length === 0 ||
		input.modelId.length > 256 ||
		!path(input.sessionDir) ||
		(input.sessionFile !== null && !path(input.sessionFile)) ||
		typeof input.system !== "string" ||
		typeof input.user !== "string" ||
		input.user.length === 0 ||
		(Object.hasOwn(input, "mode") && input.mode !== "plan" && input.mode !== "execute") ||
		(Object.hasOwn(input, "reasoningEffort") &&
			!CONVERSATION_REASONING_EFFORTS.some((level) => level === input.reasoningEffort)) ||
		(Object.hasOwn(input, "renameScope") && input.renameScope === undefined) ||
		(Object.hasOwn(input, "chartScope") &&
			(typeof input.chartScope !== "object" || input.chartScope === null || Array.isArray(input.chartScope))) ||
		Buffer.byteLength(JSON.stringify(input)) >
			(Object.hasOwn(input, "images") ? CONVERSATION_REQUEST_BYTES : ASSISTANT_REQUEST_BYTES)
	)
		fail("request");
	if (!input.system.endsWith(SYSTEM_SUFFIX) || input.system.length === SYSTEM_SUFFIX.length) fail("context");
	if (Object.hasOwn(input, "images")) {
		try {
			if (!Array.isArray(input.images)) fail("request");
			parseConversationScreenshots(
				input.images.map((image: unknown, index: number) => {
					if (
						!image ||
						typeof image !== "object" ||
						Array.isArray(image) ||
						Object.keys(image).length !== 3 ||
						!("type" in image) ||
						image.type !== "image" ||
						!("data" in image) ||
						!("mimeType" in image)
					)
						fail("request");
					return { name: `screenshot-${index}`, mediaType: image.mimeType, data: image.data };
				}),
				true,
			);
		} catch {
			fail("request");
		}
	}
	return {
		...(Object.hasOwn(input, "conversationId") ? { conversationId: input.conversationId as string } : {}),
		provider: input.provider,
		modelId: input.modelId,
		sessionFile: input.sessionFile as string | null,
		sessionDir: input.sessionDir,
		system: input.system,
		user: input.user,
		...(Object.hasOwn(input, "mode") ? { mode: input.mode as Request["mode"] } : {}),
		...(Object.hasOwn(input, "reasoningEffort")
			? { reasoningEffort: input.reasoningEffort as Request["reasoningEffort"] }
			: {}),
		...(Object.hasOwn(input, "images") ? { images: input.images as Request["images"] } : {}),
		...(Object.hasOwn(input, "renameScope") ? { renameScope: input.renameScope as Request["renameScope"] } : {}),
		...(Object.hasOwn(input, "chartScope") ? { chartScope: input.chartScope as Request["chartScope"] } : {}),
	};
}
export interface ControlledConversationSession {
 session: AgentSession;
 run(input: ConversationDriverInput, onEvent: (event: ConversationDriverEvent) => void, signal: AbortSignal): ReturnType<ConversationDriver["chat"]>;
 modelState(): SessionModelState;
}

/** Retains the SDK session; the driver checkpoints and forks its manager before each mutation. */
export async function createConversationSession(providers: ProviderService, input: Request, manager: SessionManager, draft = false): Promise<ControlledConversationSession> {
 let validateProposal: RenameProposalValidator | undefined;
 try { validateProposal = renameProposalValidator(input.mode === "plan" ? undefined : input.renameScope); } catch { fail("request"); }
 let execute: ((id: string, params: unknown, signal?: AbortSignal) => Promise<{content: {type: "text"; text: string}[]; details: undefined}>) | undefined;
 const executeProposal = (id: string, params: unknown, signal?: AbortSignal) => {
  if (!execute) fail("protocol");
  return execute(id, params, signal);
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
		...(input.mode !== "plan" && input.chartScope
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
 const runtime = providers.runtime;
 const branch = manager.getBranch();
 const savedModel = [...branch].reverse().find((entry) => entry.type === "model_change");
 const savedThinking = [...branch].reverse().find((entry) => entry.type === "thinking_level_change");
 const selected = savedModel?.type === "model_change" ? {provider: savedModel.provider, id: savedModel.modelId} : undefined;
 const model = selected ? runtime.getModel(selected.provider, selected.id) : draft ? undefined : runtime.getModel(input.provider, input.modelId);
 if ((!draft || selected) && !model) fail("model");
 const thinkingLevel = savedThinking?.type === "thinking_level_change" ? CONVERSATION_REASONING_EFFORTS.find((level) => level === savedThinking.thinkingLevel) : input.reasoningEffort;
 const loader = new DefaultResourceLoader({
  cwd: CONVERSATION_CWD, agentDir: providers.agentDir, settingsManager: providers.settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [(pi) => {
   pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const {errorMessage: _error, diagnostics: _diagnostics, ...message} = event.message;
    return {message};
   });
  }],
 });
 await loader.reload();
 const resources = loader.getExtensions();
 if (resources.errors.length || resources.extensions.length !== 1) fail("context");
 const { session } = await createAgentSession({
  cwd: CONVERSATION_CWD,
  agentDir: providers.agentDir,
  modelRuntime: runtime,
  model,
  thinkingLevel,
  tools: customTools.map((tool) => tool.name),
  customTools,
  sessionManager: manager,
  settingsManager: providers.settings,
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
 if (model && session.model !== model) { session.dispose(); fail("model"); }
 let activeStop: ((code: keyof typeof ASSISTANT_WORKER_ERRORS) => void) | undefined;
 const stream = session.agent.streamFunction;
 session.agent.streamFunction = (requestModel, context, options) => {
  const declared = getCurrentTools(context.messages);
  if (getCurrentSystemPrompt(context.messages) !== input.system || declared.length !== customTools.length || customTools.some((tool) => !declared.some((item) => item.name === tool.name))) {
   activeStop?.("context");
   fail("context");
  }
  return stream(requestModel, context, {...options, maxTokens: Math.min(requestModel.maxTokens || 8192, 8192)});
 };
 function modelState(): SessionModelState {
  const state = providers.modelState(session);
  const message = [...session.messages].reverse().find((item) => item.role === "assistant" && (item.stopReason === "stop" || item.stopReason === "toolUse"));
  if (message?.role === "assistant") {
   const physical = runtime.getPhysicalModel(message.provider, message.model);
   if (physical) state.routedModel = {provider: physical.provider, id: physical.id, name: physical.name, ...(message.thinkingLevel ? {thinkingLevel: message.thinkingLevel} : {})};
  }
  return state;
 }
 async function run(turnInput: Request, onEvent: Parameters<ConversationDriver["chat"]>[1], signal: AbortSignal) {
  if (signal.aborted) fail("cancelled");
  const selectedModel = session.model;
  if (!selectedModel) fail("model");
  if (!(await runtime.getAvailable()).some((model) => model.provider === selectedModel.provider && model.id === selectedModel.id)) fail("credentials");
  if (turnInput.images?.length && !selectedModel.input.includes("image")) fail("images");
  if (turnInput.reasoningEffort !== undefined) {
   if (!session.getAvailableThinkingLevels().includes(turnInput.reasoningEffort)) fail("reasoning");
   session.setThinkingLevel(turnInput.reasoningEffort);
  }
	let text = "";
	let bytes = 0;
	let messageText = "";
	let final = false;
	const usage: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	let failure: ConversationRuntimeFailure | undefined;
	const stop = (code: keyof typeof ASSISTANT_WORKER_ERRORS) => {
		failure ??= new ConversationRuntimeFailure(code);
		void session.abort().catch(() => {});
	};
	const abort = () => stop("cancelled");
	signal?.addEventListener("abort", abort, { once: true });
 activeStop = stop;
	const proposals = new Map<
		string,
		{ event: Extract<ConversationDriverEvent, { type: "rename_proposal" | "chart_proposal" }>; arguments: string }
	>();
	const emitted = new Set<string>();
	execute = async (toolCallId: string, params: unknown, toolSignal?: AbortSignal) => {
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
					let proposal: Extract<ConversationDriverEvent, { type: "rename_proposal" | "chart_proposal" }>;
					// Inspect the original tool arguments before Pi can coerce or strip fields.
					if (content.name === "propose_column_rename" && validateProposal) {
						if (Object.keys(args).length !== 3 || !validateProposal(value)) return stop("protocol");
						proposal = { type: "rename_proposal", ...value };
					} else if (content.name === "propose_chart" && input.mode !== "plan" && input.chartScope) {
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
            const physical = runtime.getPhysicalModel(message.provider, message.model);
            if (!physical) return stop("protocol");
            const state = providers.modelState(session);
            state.routedModel = {provider: physical.provider, id: physical.id, name: physical.name, ...(message.thinkingLevel ? {thinkingLevel: message.thinkingLevel} : {})};
            try { onEvent({type: "model", modelState: state}); } catch { stop("protocol"); }
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
		await session.prompt(turnInput.user, {
			expandPromptTemplates: false,
			...(turnInput.images?.length ? { images: turnInput.images } : {}),
		});
		await session.waitForIdle();
		if (failure) throw failure;
		if (!final || !text || proposals.size !== emitted.size) fail("provider");
		if (!session.sessionFile) fail("provider");
		return { text, usage, sessionFile: session.sessionFile, modelState: modelState() };
	} catch (error) {
		throw failure ?? (error instanceof ConversationRuntimeFailure ? error : new ConversationRuntimeFailure("provider"));
	} finally {
		signal?.removeEventListener("abort", abort);
		unsubscribe();
        execute = undefined;
        activeStop = undefined;
        await session.abort();
	}
}
 return {session, run, modelState};
}
