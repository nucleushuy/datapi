import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Message,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ProviderService } from "../src/provider-service.ts";

async function setup(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "datapi-router-"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	// Disable ambient built-in auth in this runtime, never in the process or user profile.
	for (const provider of runtime.getProviders()) {
		runtime.registerNativeProvider({
			...provider,
			auth: {
				apiKey: {
					name: "Disabled test ambient auth",
					check: async () => undefined,
					resolve: async () => undefined,
				},
			},
		});
	}
	const eligible = fauxProvider({
		provider: "routing-future",
		models: [
			{
				id: "economy-text",
				input: ["text"],
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 8192,
				cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "reasoning-vision",
				input: ["text", "image"],
				reasoning: true,
				contextWindow: 128_000,
				maxTokens: 8192,
				cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "costly-continuity",
				input: ["text", "image"],
				reasoning: true,
				contextWindow: 128_000,
				maxTokens: 8192,
				cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "too-small",
				input: ["text", "image"],
				reasoning: true,
				contextWindow: 128,
				maxTokens: 64,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "filtered-out",
				input: ["text", "image"],
				reasoning: true,
				contextWindow: 128_000,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	const unavailable = fauxProvider({
		provider: "routing-no-credentials",
		models: [
			{
				id: "free-but-not-configured",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 128_000,
				maxTokens: 8192,
			},
		],
	});
	runtime.registerNativeProvider({
		...eligible.provider,
		filterModels: (models) => models.filter((model) => model.id !== "filtered-out"),
	});
	runtime.registerNativeProvider({
		...unavailable.provider,
		auth: { apiKey: { name: "Unavailable", check: async () => undefined, resolve: async () => undefined } },
	});
	const service = await ProviderService.create(dir, { runtime });
	await runtime.refresh({ allowNetwork: false });
	t.after(async () => {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	});
	const auto = runtime.getModel("router", "auto")!;
	const text: Message[] = [
		{ role: "system", content: "Data analysis ".repeat(100), timestamp: 1 },
		{ role: "user", content: "Explain this result", timestamp: 2 },
	];
	return { dir, runtime, service, eligible, unavailable, auto, text };
}
function response(model: { api: string; provider: string; id: string }, failed = false): AssistantMessage {
	return {
		...fauxAssistantMessage("authoritative response"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		thinkingLevel: "high",
		stopReason: failed ? "error" : "stop",
		...(failed ? { errorMessage: "transient rate limit" } : {}),
	};
}

describe("real Pi Auto virtual model", { concurrency: false, timeout: 60_000 }, () => {
	it("routes from getAvailable using cost, image/context and reasoning requirements without a classifier call", async (t) => {
		const { runtime, eligible, unavailable, auto, text } = await setup(t);
		assert.equal(runtime.getPhysicalModel("router", "auto"), undefined);
		assert.ok((await runtime.getAvailable()).includes(auto));
		const cheap = await runtime.resolveModel(auto, text, { reason: "user", thinkingLevel: "off" });
		assert.equal(cheap.model.id, "economy-text");
		const reasoning = await runtime.resolveModel(auto, text, { reason: "user", thinkingLevel: "high" });
		assert.equal(reasoning.model.id, "reasoning-vision");
		assert.equal(reasoning.thinkingLevel, "high");
		const image: Message = {
			role: "user",
			content: [{ type: "image", data: "fixture-image", mimeType: "image/png" }],
			timestamp: 3,
		};
		const vision = await runtime.resolveModel(auto, [...text, image], { reason: "user", thinkingLevel: "off" });
		assert.equal(vision.model.id, "reasoning-vision");
		assert.equal(eligible.state.callCount, 0);
		assert.equal(unavailable.state.callCount, 0);
		await assert.rejects(
			runtime.resolveModel(auto, [{ role: "user", content: "x".repeat(600_000), timestamp: 1 }], {
				reason: "user",
				thinkingLevel: "high",
			}),
			/No available model supports/,
		);
	});

	it("prefers the previous continuation and failed retry model, but never an unavailable candidate", async (t) => {
		const { runtime, eligible, auto, text } = await setup(t);
		const expensive = eligible.getModel("costly-continuity")!;
		const previous = response(expensive);
		const continuation = await runtime.resolveModel(auto, [...text, previous], {
			reason: "continuation",
			thinkingLevel: "high",
		});
		assert.equal(continuation.model.id, expensive.id);
		const retry = await runtime.resolveModel(auto, text, {
			reason: "retry",
			thinkingLevel: "high",
			failed: response(expensive, true),
		});
		assert.equal(retry.model.id, expensive.id);
		const excluded = eligible.getModel("filtered-out")!;
		const availableRetry = await runtime.resolveModel(auto, text, {
			reason: "retry",
			thinkingLevel: "high",
			failed: response(excluded, true),
		});
		assert.equal(availableRetry.model.id, "reasoning-vision");
		const newTurn = await runtime.resolveModel(auto, [...text, previous], { reason: "user", thinkingLevel: "off" });
		assert.equal(newTurn.model.id, "economy-text");
	});

	it("keeps virtual selection on a real AgentSession and reports only its authoritative physical response", async (t) => {
		const { dir, runtime, service, eligible, auto } = await setup(t);
		eligible.setResponses([fauxAssistantMessage("Real routed response")]);
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: service.agentDir,
			settingsManager: service.settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Explain approved data only.",
		});
		await loader.reload();
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: service.agentDir,
			modelRuntime: runtime,
			model: auto,
			thinkingLevel: "high",
			tools: [],
			resourceLoader: loader,
			settingsManager: service.settings,
			sessionManager: manager,
		});
		t.after(() => session.dispose());
		assert.equal(session.modelRuntime, runtime);
		assert.equal(service.modelState(session).model?.virtual, true);
		assert.equal(service.modelState(session).routedModel, null);
		await session.prompt("Describe the approved summary ".repeat(100), { expandPromptTemplates: false });
		await session.agent.waitForIdle();
		const state = service.modelState(session);
		assert.equal(state.model?.provider, "router");
		assert.equal(state.model?.id, "auto");
		assert.equal(state.thinkingLevel, session.thinkingLevel);
		assert.equal(state.routedModel?.id, "reasoning-vision");
		let actual: AssistantMessage | undefined;
		for (let index = session.messages.length - 1; index >= 0; index--) {
			const message = session.messages[index];
			if (message?.role === "assistant") {
				actual = message;
				break;
			}
		}
		assert.ok(actual?.role === "assistant");
		assert.equal(state.routedModel?.provider, actual.provider);
		assert.equal(state.routedModel?.id, actual.model);
		assert.equal(eligible.state.callCount, 1);
		const saved = manager.getSessionFile()!;
		const restored = await createAgentSession({
			cwd: dir,
			agentDir: service.agentDir,
			modelRuntime: runtime,
			tools: [],
			resourceLoader: loader,
			settingsManager: service.settings,
			sessionManager: SessionManager.open(saved),
		});
		t.after(() => restored.session.dispose());
		assert.equal(restored.session.modelRuntime, runtime);
		assert.deepEqual(service.modelState(restored.session), state);
		restored.session.dispose();
		session.dispose();
	});
});
