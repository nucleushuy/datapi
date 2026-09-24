import { pathToFileURL } from "node:url";
import { type AssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	ASSISTANT_OUTPUT_BYTES,
	type AssistantPayload,
	type AssistantProgress,
	type AssistantUsage,
} from "./assistant-contracts.ts";
import {
	ASSISTANT_CATALOG_BYTES,
	ASSISTANT_PROVIDERS,
	ASSISTANT_REQUEST_BYTES,
	type AssistantWorkerErrorCode,
	type AssistantWorkerRequest,
	isAssistantUsage,
	parseAssistantWorkerRequest,
} from "./assistant-driver.ts";

const ASSISTANT_VIRTUAL_CWD = process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant";
const SYSTEM_SUFFIX = `\nCurrent working directory: ${ASSISTANT_VIRTUAL_CWD}\n`;
type GenerateRequest = Extract<AssistantWorkerRequest, { operation: "generate" }>;
class WorkerFailure extends Error {
	readonly code: AssistantWorkerErrorCode;
	constructor(code: AssistantWorkerErrorCode) {
		super(code);
		this.code = code;
	}
}

async function createRuntime(credentials: Record<string, string>): Promise<ModelRuntime> {
	const store = new InMemoryCredentialStore();
	for (const [provider, key] of Object.entries(credentials)) {
		await store.modify(provider, async () => ({ type: "api_key", key }));
	}
	return await ModelRuntime.create({
		credentials: store,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
}

/** Constructs only the fixed approved resource set on an explicitly supplied memory runtime. */
export async function createAssistantSession(request: GenerateRequest, runtime: ModelRuntime): Promise<AgentSession> {
	parseAssistantWorkerRequest(request);
	if (!request.payload.system.endsWith(SYSTEM_SUFFIX)) throw new WorkerFailure("context");
	const system = request.payload.system.slice(0, -SYSTEM_SUFFIX.length);
	if (!system) throw new WorkerFailure("context");
	const selected = runtime.getModel(request.provider, request.modelId);
	if (!selected) throw new WorkerFailure("model");
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const { session } = await createAgentSession({
		cwd: ASSISTANT_VIRTUAL_CWD,
		agentDir: ASSISTANT_VIRTUAL_CWD,
		modelRuntime: runtime,
		model: { ...selected, maxTokens: Math.min(selected.maxTokens, 8192) },
		thinkingLevel: "off",
		tools: [],
		customTools: [],
		sessionManager: SessionManager.inMemory(ASSISTANT_VIRTUAL_CWD),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } },
			enableAnalytics: false,
			enableInstallTelemetry: false,
			enableSkillCommands: false,
			transport: "sse",
		}),
		resourceLoader: {
			getExtensions: () => extensions,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => system,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			// A fixed resource set deliberately never discovers disk resources.
			extendResources: () => {},
			reload: async () => {},
		},
	});
	if (
		session.systemPrompt !== request.payload.system ||
		session.getActiveToolNames().length !== 0 ||
		session.messages.length !== 0
	) {
		session.dispose();
		throw new WorkerFailure("context");
	}
	return session;
}

function usageOf(message: AssistantMessage): AssistantUsage {
	const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
	const usage = { input, output, cacheRead, cacheWrite, totalTokens };
	if (!isAssistantUsage(usage)) throw new WorkerFailure("provider");
	return usage;
}
function emit(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}
/** Executes one fresh SDK session; only counters and normalized usage stream before validation. */
export async function runAssistantSession(
	session: AgentSession,
	payload: AssistantPayload,
	onProgress: (progress: AssistantProgress) => void,
	signal?: AbortSignal,
): Promise<{ text: string; usage: AssistantUsage }> {
	let receivedCharacters = 0;
	let bytes = 0;
	let reportedCharacters = 0;
	let finalMessage: AssistantMessage | undefined;
	let failure: WorkerFailure | undefined;
	const abort = () => {
		failure ??= new WorkerFailure("cancelled");
		void session.abort().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	const unsubscribe = session.subscribe((event) => {
		if (failure) return;
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			const delta = event.assistantMessageEvent.delta;
			bytes += Buffer.byteLength(delta);
			if (bytes > ASSISTANT_OUTPUT_BYTES) {
				failure = new WorkerFailure("output");
				void session.abort().catch(() => {});
				return;
			}
			receivedCharacters += delta.length;
			if (receivedCharacters - reportedCharacters >= 512) {
				reportedCharacters = receivedCharacters;
				onProgress({ type: "progress", receivedCharacters: reportedCharacters });
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			if (finalMessage || event.message.stopReason !== "stop") {
				failure = new WorkerFailure(event.message.stopReason === "length" ? "output" : "provider");
				void session.abort().catch(() => {});
				return;
			}
			finalMessage = event.message;
		}
	});
	try {
		if (signal?.aborted) throw new WorkerFailure("cancelled");
		// Check the public SDK result, not merely the intended loader input.
		if (
			session.systemPrompt !== payload.system ||
			session.messages.length !== 0 ||
			session.getActiveToolNames().length !== 0
		)
			throw new WorkerFailure("context");
		await session.prompt(payload.user, { expandPromptTemplates: false });
		await session.waitForIdle();
		if (failure) throw failure;
		if (!finalMessage || finalMessage.stopReason !== "stop") throw new WorkerFailure("provider");
		let text = "";
		let textBytes = 0;
		for (const content of finalMessage.content) {
			if (content.type === "text") {
				textBytes += Buffer.byteLength(content.text);
				if (textBytes > ASSISTANT_OUTPUT_BYTES) throw new WorkerFailure("output");
				text += content.text;
			} else if (content.type !== "thinking") throw new WorkerFailure("provider");
		}
		if (!text || text.length < reportedCharacters) throw new WorkerFailure("output");
		const usage = usageOf(finalMessage);
		onProgress({ type: "progress", receivedCharacters: text.length });
		onProgress({ type: "usage", usage });
		return { text, usage };
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

async function readRequest(): Promise<AssistantWorkerRequest> {
	const fragments: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		const fragment = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += fragment.length;
		if (bytes > ASSISTANT_REQUEST_BYTES) throw new WorkerFailure("request");
		fragments.push(fragment);
	}
	try {
		return parseAssistantWorkerRequest(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(fragments, bytes))),
		);
	} catch {
		throw new WorkerFailure("request");
	}
}
async function main(): Promise<void> {
	try {
		const request = await readRequest();
		if (request.operation === "generate") {
			if (!Object.hasOwn(request.credentials, request.provider)) throw new WorkerFailure("credentials");
			const runtime = await createRuntime(request.credentials);
			const session = await createAssistantSession(request, runtime);
			const result = await runAssistantSession(session, request.payload, emit);
			emit({ type: "result", ...result });
		} else {
			const runtime = await createRuntime(request.credentials);
			const models = [];
			for (const provider of ASSISTANT_PROVIDERS) {
				for (const model of runtime.getModels(provider)) {
					models.push({
						provider,
						id: model.id,
						name: model.name,
						configured: false,
						contextWindow: model.contextWindow,
					});
				}
			}
			const frame = { type: "models", models };
			if (Buffer.byteLength(JSON.stringify(frame)) > ASSISTANT_CATALOG_BYTES) throw new WorkerFailure("output");
			emit(frame);
		}
	} catch (error) {
		emit({ type: "error", code: error instanceof WorkerFailure ? error.code : "provider" });
	}
	// Flush the sole protocol stream before exit; no SDK logger/error object leaves this child.
	await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
	process.exit(0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.stdout.on("error", () => process.exit(1));
	void main();
}
