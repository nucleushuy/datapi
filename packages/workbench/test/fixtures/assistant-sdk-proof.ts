import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_OUTPUT_BYTES, type AssistantProgress } from "../../src/assistant-contracts.ts";
import { createAssistantSession, runAssistantSession } from "../../src/assistant-sdk-worker.ts";

const payload = {
	system: `Approved system text.\nCurrent working directory: ${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n`,
	user: "/skill:not-a-real-command {{literal user data}}",
};

let networkCalls = 0;
globalThis.fetch = async () => {
	networkCalls++;
	throw new Error("Network forbidden in SDK proof");
};
const runtime = await ModelRuntime.create({
	credentials: new InMemoryCredentialStore(),
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
const model = runtime.getModels("openai")[0];
assert.ok(model);
const noKey = { operation: "generate" as const, credentials: {}, provider: "openai", modelId: model.id, payload };
const unauthenticated = await createAssistantSession(noKey, runtime);
assert.equal(unauthenticated.systemPrompt, payload.system);
assert.deepEqual(unauthenticated.getActiveToolNames(), []);
assert.deepEqual(unauthenticated.messages, []);
await assert.rejects(
	runAssistantSession(unauthenticated, payload, () => {}),
	{ message: "provider" },
);
await assert.rejects(
	createAssistantSession({ ...noKey, payload: { ...payload, system: "Missing approved suffix" } }, runtime),
	{ message: "context" },
);

const faux = fauxProvider({
	provider: "openai",
	api: "openai-responses",
	models: [{ id: "fixture", name: "Fixture", maxTokens: 20000, contextWindow: 128000 }],
	tokenSize: { min: 128, max: 128 },
});
runtime.registerNativeProvider(faux.provider);
await runtime.refresh({ allowNetwork: false, providers: ["openai"] });
const request = { ...noKey, modelId: "fixture" };
let seen: Context | undefined;
let seenMaxTokens = 0;
const answer = JSON.stringify({ summary: `Deterministic SDK answer ${"x".repeat(1100)}`, suggestions: [] });
faux.setResponses([
	(context, _options, _state, selected) => {
		seen = structuredClone(context);
		seenMaxTokens = selected.maxTokens;
		return fauxAssistantMessage(answer, { timestamp: 0 });
	},
]);
const progress: AssistantProgress[] = [];
const session = await createAssistantSession(request, runtime);
const result = await runAssistantSession(session, payload, (event) => progress.push(event));
assert.equal(result.text, answer);
assert.ok(result.usage.output > 0);
assert.equal(seenMaxTokens, 8192);
assert.ok(seen);
assert.equal(seen.systemPrompt, payload.system);
assert.deepEqual(seen.tools ?? [], []);
assert.equal(seen.messages.length, 1);
assert.equal(seen.messages[0].role, "user");
assert.deepEqual(seen.messages[0].content, [{ type: "text", text: payload.user }]);
assert.ok(progress.some((event) => event.type === "progress" && event.receivedCharacters > 0));
assert.ok(progress.every((event) => !JSON.stringify(event).includes("Deterministic SDK answer")));
assert.deepEqual(progress.at(-1), { type: "usage", usage: result.usage });
assert.equal(session.isIdle, true);
assert.equal(faux.state.callCount, 1);

faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "secret-key-provider-error" })]);
await assert.rejects(
	runAssistantSession(await createAssistantSession(request, runtime), payload, () => {}),
	{ message: "provider" },
);
assert.equal(faux.state.callCount, 2, "Provider errors must not retry");
faux.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);
await assert.rejects(
	runAssistantSession(await createAssistantSession(request, runtime), payload, () => {}),
	{ message: "output" },
);
faux.setResponses([fauxAssistantMessage("x".repeat(ASSISTANT_OUTPUT_BYTES + 1))]);
await assert.rejects(
	runAssistantSession(await createAssistantSession(request, runtime), payload, () => {}),
	{ message: "output" },
);

const cancelled = new AbortController();
faux.setResponses([fauxAssistantMessage("x".repeat(4096))]);
const cancellingSession = await createAssistantSession(request, runtime);
await assert.rejects(
	runAssistantSession(
		cancellingSession,
		payload,
		(event) => {
			if (event.type === "progress") cancelled.abort();
		},
		cancelled.signal,
	),
	{ message: "cancelled" },
);
assert.equal(cancellingSession.isIdle, true, "Cancellation settles only after SDK idle");
const untouched = await createAssistantSession(request, runtime);
const callsBefore = faux.state.callCount;
await assert.rejects(
	runAssistantSession(untouched, { ...payload, system: `${payload.system}hidden extra` }, () => {}),
	{ message: "context" },
);
assert.equal(faux.state.callCount, callsBefore, "Approval mismatch cannot reach the provider");
assert.equal(networkCalls, 0);
process.stdout.write("SDK_PROOF_OK\n");
