import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ASSISTANT_OUTPUT_BYTES } from "../../src/assistant-contracts.ts";
import { PiConversationDriver } from "../../src/conversation-driver.ts";
import { runConversationSession } from "../../src/conversation-sdk-worker.ts";
import { createFauxConversationRuntime } from "./conversation-faux-driver.ts";

let networkCalls = 0;
globalThis.fetch = async () => {
	networkCalls++;
	throw new Error("Network is forbidden");
};
const root = await mkdtemp(join(tmpdir(), "pi-conversation-sdk-"));
const credentials = new PiConversationDriver(root);
try {
	await credentials.setCredential("openai", "literal-test-not-a-real-key");
	const { runtime, faux } = await createFauxConversationRuntime();
	const frozen = JSON.stringify({
		dataset: { name: "Frozen dataset", rowsIncluded: false },
		attachedFiles: [{ name: "reference.sql", mediaType: "text/plain", content: "select 'snow 雪';\n" }],
		executionResults: [{ id: "execution-1", status: "completed", changedCells: 3 }],
	});
	const input = {
		authPath: join(root, "pi", "auth.json"),
		provider: "openai",
		modelId: "fixture",
		sessionDir: join(root, "sessions"),
		sessionFile: null,
		system: `Read-only frozen context: ${frozen}\nCurrent working directory: ${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n`,
		user: "/skill:not-a-command {{literal user data}}",
	};
	let seen: Context | undefined;
	let maxTokens = 0;
	const answer = "A streaming response with Unicode 雪. ".repeat(8);
	faux.setResponses([
		(context, _options, _state, model) => {
			seen = structuredClone(context);
			maxTokens = model.maxTokens;
			return fauxAssistantMessage(answer, { timestamp: 0 });
		},
	]);
	const events: string[] = [];
	const result = await runConversationSession(input, ({ delta }) => events.push(delta), undefined, runtime).then(
		(value) => {
			events.push("FINAL");
			return value;
		},
	);
	assert.ok(events.length > 2, "SDK must stream multiple deltas before completing");
	assert.equal(events.at(-1), "FINAL");
	assert.equal(events.slice(0, -1).join(""), answer);
	assert.equal(result.text, answer);
	assert.ok(result.usage.output > 0);
	assert.equal(maxTokens, 8192);
	assert.ok(seen);
	assert.equal(seen.systemPrompt, input.system);
	assert.deepEqual(seen.tools ?? [], []);
	assert.equal(seen.messages.length, 1);
	assert.deepEqual(seen.messages[0].content, [{ type: "text", text: input.user }]);
	await access(result.sessionFile);
	const persisted = await readFile(result.sessionFile, "utf8");
	assert.ok(persisted.includes("literal user data"));

	// A fresh runtime and a reopened disk session, not an in-memory transcript imitation.
	const resumedRuntime = await createFauxConversationRuntime();
	let resumed: Context | undefined;
	resumedRuntime.faux.setResponses([
		(context) => {
			resumed = structuredClone(context);
			return fauxAssistantMessage("Follow-up answer", { timestamp: 1 });
		},
	]);
	const next = await runConversationSession(
		{ ...input, sessionFile: result.sessionFile, user: "Continue using the frozen context." },
		() => {},
		undefined,
		resumedRuntime.runtime,
	);
	assert.equal(next.sessionFile, result.sessionFile);
	assert.ok(resumed);
	assert.equal(resumed.systemPrompt, input.system);
	assert.deepEqual(resumed.tools ?? [], []);
	assert.equal(resumed.messages.length, 3);
	assert.deepEqual(
		resumed.messages.map((message) => message.role),
		["user", "assistant", "user"],
	);
	assert.deepEqual(resumed.messages[0].content, seen.messages[0].content);
	assert.deepEqual(resumed.messages[1].content, [{ type: "text", text: answer }]);
	assert.deepEqual(resumed.messages[2].content, [{ type: "text", text: "Continue using the frozen context." }]);

	const before = faux.state.callCount;
	await assert.rejects(
		runConversationSession({ ...input, system: `${input.system}hidden` }, () => {}, undefined, runtime),
		{ message: "context" },
	);
	await assert.rejects(
		runConversationSession(input, () => {}, AbortSignal.abort(), runtime),
		{ message: "cancelled" },
	);
	assert.equal(faux.state.callCount, before, "Rejected context and pre-cancel cannot reach provider");
	for (const stopReason of ["error", "length"] as const) {
		const calls = faux.state.callCount;
		faux.setResponses([fauxAssistantMessage("partial", { stopReason, errorMessage: "secret-provider-error" })]);
		await assert.rejects(
			runConversationSession(input, () => {}, undefined, runtime),
			{ message: stopReason === "length" ? "output" : "provider" },
		);
		assert.equal(faux.state.callCount, calls + 1, "Provider failures must never retry");
	}
	faux.setResponses([fauxAssistantMessage("x".repeat(ASSISTANT_OUTPUT_BYTES + 1))]);
	let bytes = 0;
	await assert.rejects(
		runConversationSession(
			input,
			({ delta }) => {
				bytes += Buffer.byteLength(delta);
			},
			undefined,
			runtime,
		),
		{ message: "output" },
	);
	assert.ok(bytes <= ASSISTANT_OUTPUT_BYTES);
	faux.setResponses([fauxAssistantMessage("cancel me ".repeat(100))]);
	const abort = new AbortController();
	let deltas = 0;
	await assert.rejects(
		runConversationSession(
			input,
			() => {
				deltas++;
				abort.abort();
			},
			abort.signal,
			runtime,
		),
		{ message: "cancelled" },
	);
	assert.equal(deltas, 1, "No text follows cancellation");
	faux.setResponses([fauxAssistantMessage("After cancellation")]);
	assert.equal((await runConversationSession(input, () => {}, undefined, runtime)).text, "After cancellation");

	// Pi auth storage may contain externally written values; never execute their resolver syntax.
	const marker = join(root, "executed");
	const hostile = `!node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')"`;
	await writeFile(input.authPath, JSON.stringify({ openai: { type: "api_key", key: hostile } }));
	const calls = faux.state.callCount;
	await assert.rejects(
		runConversationSession(input, () => {}, undefined, runtime),
		{ message: "credentials" },
	);
	await assert.rejects(access(marker), { code: "ENOENT" });
	assert.equal(faux.state.callCount, calls);
	await writeFile(input.authPath, "{}");
	await assert.rejects(
		runConversationSession(input, () => {}, undefined, runtime),
		{ message: "credentials" },
	);
	assert.equal(networkCalls, 0);
	process.stdout.write("CONVERSATION_SDK_PROOF_OK\n");
} finally {
	await credentials.close();
	await rm(root, { recursive: true, force: true });
}
