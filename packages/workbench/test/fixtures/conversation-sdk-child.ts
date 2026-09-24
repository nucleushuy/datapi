import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ASSISTANT_OUTPUT_BYTES } from "../../src/assistant-contracts.ts";
import { runConversationSession } from "../../src/conversation-sdk-worker.ts";
import { createFauxConversationRuntime } from "./conversation-faux-driver.ts";

globalThis.fetch = async () => {
	throw new Error("Network is forbidden in the conversation SDK fixture");
};
const mode = process.argv[2] ?? "success";
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
if (mode === "mismatch") {
	emit({ type: "text", delta: "visible" });
	emit({ type: "result", text: "different", sessionFile: "fixture.jsonl", usage });
} else if (mode === "after-result") {
	emit({ type: "text", delta: "visible" });
	emit({ type: "result", text: "visible", sessionFile: "fixture.jsonl", usage });
	emit({ type: "text", delta: "late" });
} else if (mode === "utf8") {
	process.stdout.write(Buffer.from([0xff, 10]));
} else if (mode === "oversized-line") {
	process.stdout.write("x".repeat(6 * ASSISTANT_OUTPUT_BYTES + 8193));
} else {
	try {
		const { runtime, faux } = await createFauxConversationRuntime({
			tokensPerSecond: mode === "cancel" ? 100 : undefined,
		});
		faux.setResponses([
			mode === "provider-error"
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "secret-provider-error" })
				: fauxAssistantMessage("Real Pi child streaming response. ".repeat(mode === "cancel" ? 100 : 3)),
		]);
		const result = await runConversationSession(input, emit, undefined, runtime);
		emit({ type: "result", ...result });
	} catch (error) {
		emit({ type: "error", code: error instanceof Error ? error.message : "provider" });
	}
}
