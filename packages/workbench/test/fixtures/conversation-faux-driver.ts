import { join } from "node:path";
import {
	type Context,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantDriver, AssistantModels } from "../../src/assistant-contracts.ts";
import { ASSISTANT_WORKER_ERRORS } from "../../src/assistant-driver.ts";
import type { ConversationDriver } from "../../src/conversation-contracts.ts";
import { PiConversationDriver } from "../../src/conversation-driver.ts";
import { runConversationSession } from "../../src/conversation-sdk-worker.ts";
import { WorkbenchError } from "../../src/storage.ts";

export const FAUX_CONVERSATION_MODEL = {
	provider: "openai",
	id: "fixture",
	name: "Deterministic Pi fixture",
	configured: true,
	contextWindow: 128000,
};

/** Test-only native provider. No URL, API credential resolver, or network transport is installed. */
export async function createFauxConversationRuntime(options: { tokensPerSecond?: number } = {}) {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "openai",
		api: "openai-responses",
		models: [{ id: "fixture", name: "Fixture", maxTokens: 20000, contextWindow: 128000 }],
		tokenSize: { min: 16, max: 16 },
		tokensPerSecond: options.tokensPerSecond,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: ["openai"] });
	return { runtime, faux };
}

export async function createFauxConversationDriver(
	dataDir: string,
	options: { tokensPerSecond?: number; beforeResult?: () => Promise<void> } = {},
): Promise<FauxConversationFixture> {
	const { runtime, faux } = await createFauxConversationRuntime(options);
	const credentials = new PiConversationDriver(dataDir);
	const seen: Context[] = [];
	const active = new Set<AbortController>();
	let closed = false;
	const driver: ConversationDriver & Pick<PiConversationDriver, "authorizedProviders"> = {
		setCredential: (provider, key) => credentials.setCredential(provider, key),
		deleteCredential: (provider) => credentials.deleteCredential(provider),
		authorizedProviders: () => credentials.authorizedProviders(),
		async chat(input, onText, signal) {
			if (closed) throw new WorkbenchError(503, "Assistant is closed.");
			const controller = new AbortController();
			active.add(controller);
			const combined = AbortSignal.any([signal, controller.signal]);
			faux.appendResponses([
				(context) => {
					seen.push(structuredClone(context));
					return fauxAssistantMessage(
						"Deterministic Pi streaming reply. Frozen dataset metadata and explicitly attached files remain read-only. No files or tools were executed.",
						{ timestamp: 0 },
					);
				},
			]);
			try {
				const result = await runConversationSession(
					{ ...input, authPath: join(dataDir, "pi", "auth.json") },
					onText,
					combined,
					runtime,
				);
				await options.beforeResult?.();
				if (combined.aborted) throw new Error("cancelled");
				return result;
			} catch (cause) {
				const code =
					cause instanceof Error && Object.hasOwn(ASSISTANT_WORKER_ERRORS, cause.message)
						? (cause.message as keyof typeof ASSISTANT_WORKER_ERRORS)
						: "provider";
				throw new WorkbenchError(
					code === "cancelled" ? 499 : code === "credentials" ? 409 : 502,
					ASSISTANT_WORKER_ERRORS[code],
				);
			} finally {
				active.delete(controller);
			}
		},
		async close() {
			closed = true;
			for (const controller of active) controller.abort();
			await credentials.close();
		},
	};
	const catalogResult: AssistantModels = {
		models: [FAUX_CONVERSATION_MODEL],
		guidance: "Deterministic local SDK provider; no hosted API calls.",
	};
	const catalog: Pick<AssistantDriver, "models"> & { close(): Promise<void> } = {
		async models() {
			return structuredClone(catalogResult);
		},
		async close() {},
	};
	return { driver, catalog, seen, faux };
}

export interface FauxConversationFixture {
	driver: ConversationDriver & Pick<PiConversationDriver, "authorizedProviders">;
	catalog: Pick<AssistantDriver, "models"> & { close(): Promise<void> };
	seen: Context[];
	faux: FauxProviderHandle;
}
