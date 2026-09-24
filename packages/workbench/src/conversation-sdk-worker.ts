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
import { ASSISTANT_OUTPUT_BYTES } from "./assistant-contracts.ts";
import {
	ASSISTANT_PROVIDERS,
	ASSISTANT_WORKER_ERRORS,
	isAssistantApiKey,
	isAssistantUsage,
} from "./assistant-driver.ts";

const VIRTUAL_CWD = process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant";
const SYSTEM_SUFFIX = `\nCurrent working directory: ${VIRTUAL_CWD}\n`;

interface Request {
	authPath: string;
	provider: string;
	modelId: string;
	sessionFile: string | null;
	sessionDir: string;
	system: string;
	user: string;
}

function fail(code: keyof typeof ASSISTANT_WORKER_ERRORS): never {
	throw new Error(code);
}
function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function request(value: unknown): Request {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("request");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 7 ||
		typeof input.authPath !== "string" ||
		input.authPath.length === 0 ||
		input.authPath.length > 4096 ||
		input.authPath.includes("\0") ||
		typeof input.provider !== "string" ||
		!ASSISTANT_PROVIDERS.has(input.provider) ||
		typeof input.modelId !== "string" ||
		typeof input.sessionDir !== "string" ||
		(input.sessionFile !== null && typeof input.sessionFile !== "string") ||
		typeof input.system !== "string" ||
		typeof input.user !== "string" ||
		!input.system.endsWith(SYSTEM_SUFFIX)
	)
		fail("request");
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
async function main(): Promise<void> {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		const input = request(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
		const credential = readStoredCredential(input.provider, input.authPath);
		if (credential?.type !== "api_key" || !isAssistantApiKey(credential.key)) fail("credentials");
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(input.provider, async () => ({ type: "api_key", key: credential.key }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const model = runtime.getModel(input.provider, input.modelId);
		if (!model) fail("model");
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
		if (session.systemPrompt !== input.system || session.getActiveToolNames().length !== 0) fail("context");
		let text = "";
		let final: AssistantMessage | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				text += event.assistantMessageEvent.delta;
				if (Buffer.byteLength(text) > ASSISTANT_OUTPUT_BYTES) void session.abort();
				else emit({ type: "text", delta: event.assistantMessageEvent.delta });
			}
			if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop")
				final = event.message;
		});
		try {
			await session.prompt(input.user, { expandPromptTemplates: false });
			await session.waitForIdle();
		} finally {
			unsubscribe();
		}
		if (!final || !text) fail("provider");
		const usage = {
			input: final.usage.input,
			output: final.usage.output,
			cacheRead: final.usage.cacheRead,
			cacheWrite: final.usage.cacheWrite,
			totalTokens: final.usage.totalTokens,
		};
		if (!isAssistantUsage(usage) || !session.sessionFile) fail("provider");
		emit({ type: "result", text, usage, sessionFile: session.sessionFile });
		session.dispose();
	} catch (error) {
		emit({
			type: "error",
			code:
				error instanceof Error && Object.hasOwn(ASSISTANT_WORKER_ERRORS, error.message)
					? error.message
					: "provider",
		});
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
