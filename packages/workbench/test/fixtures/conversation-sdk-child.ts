import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ASSISTANT_OUTPUT_BYTES } from "../../src/assistant-contracts.ts";
import { runConversationSession } from "../../src/conversation-sdk-worker.ts";
import {
	createFauxConversationRuntime,
	fauxConversationChart,
	fauxConversationChartScope,
} from "./conversation-faux-driver.ts";

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
} else if (mode.startsWith("proposal-")) {
	const proposal = {
		type: "rename_proposal",
		toolCallId: "rename-1",
		datasetVersionId: "v1",
		column: 0,
		name: "cohort",
	};
	if (mode === "proposal-extra") emit({ ...proposal, sql: "SELECT secret" });
	else if (mode === "proposal-stale") emit({ ...proposal, datasetVersionId: "v2" });
	else if (mode === "proposal-hidden") emit({ ...proposal, column: 5 });
	else if (mode === "proposal-duplicate-name") emit({ ...proposal, name: "value" });
	else if (mode === "proposal-fractional") emit({ ...proposal, column: 0.5 });
	else if (mode === "proposal-invalid-name") emit({ ...proposal, name: " " });
	else if (mode === "proposal-duplicate-id") {
		emit(proposal);
		emit(proposal);
	} else if (mode === "proposal-over-limit") {
		for (let index = 0; index < 9; index++) emit({ ...proposal, toolCallId: `rename-${index}` });
	} else emit(proposal);
	emit({ type: "text", delta: "Awaiting local review." });
	emit({ type: "result", text: "Awaiting local review.", sessionFile: "fixture.jsonl", usage });
} else if (mode.startsWith("chart-proposal-")) {
	const args = fauxConversationChart(fauxConversationChartScope());
	const proposal = { type: "chart_proposal", toolCallId: "chart-1", ...args };
	if (mode === "chart-proposal-extra") emit({ ...proposal, basis: "evidence-linked" });
	else if (mode === "chart-proposal-stale") emit({ ...proposal, spec: { ...args.spec, datasetVersionId: "v2" } });
	else if (mode === "chart-proposal-hidden") emit({ ...proposal, spec: { ...args.spec, x: 2 } });
	else if (mode === "chart-proposal-evidence") emit({ ...proposal, evidenceRefs: ["forged-record"] });
	else if (mode === "chart-proposal-affected") emit({ ...proposal, affectedColumns: [] });
	else if (mode === "chart-proposal-coercion") emit({ ...proposal, confidence: "0.8" });
	else if (mode === "chart-proposal-model-result")
		emit({ ...proposal, spec: { ...args.spec, type: "model-result", x: null, aggregation: "none" } });
	else if (mode === "chart-proposal-mixed-duplicate") {
		emit({ type: "rename_proposal", toolCallId: "chart-1", datasetVersionId: "v1", column: 0, name: "cohort" });
		emit(proposal);
	} else if (mode === "chart-proposal-mixed-over-limit") {
		for (let index = 0; index < 9; index++)
			emit(
				index % 2
					? { ...proposal, toolCallId: `mixed-${index}` }
					: {
							type: "rename_proposal",
							toolCallId: `mixed-${index}`,
							datasetVersionId: "v1",
							column: 0,
							name: "cohort",
						},
			);
	} else if (mode === "chart-proposal-bytes") {
		for (let index = 0; index < 8; index++)
			emit({
				...proposal,
				toolCallId: `bytes-${index}`,
				explanation: "雪".repeat(4000),
				spec: {
					...args.spec,
					filters: Array.from({ length: 8 }, () => ({ column: 1, op: "eq", value: "雪".repeat(512) })),
				},
			});
	} else if (mode === "chart-proposal-text-bytes") {
		emit(proposal);
		emit({ type: "text", delta: "x".repeat(ASSISTANT_OUTPUT_BYTES) });
	} else emit(proposal);
	emit({ type: "text", delta: "Awaiting local review." });
	emit({ type: "result", text: "Awaiting local review.", sessionFile: "fixture.jsonl", usage });
} else {
	try {
		const { runtime, faux } = await createFauxConversationRuntime({
			tokensPerSecond: mode === "cancel" ? 100 : undefined,
		});
		if (mode === "rename") {
			faux.setResponses([
				fauxAssistantMessage(
					[
						{ type: "text", text: "I can propose that rename. " },
						fauxToolCall(
							"propose_column_rename",
							{
								column: 0,
								name: "cohort",
								datasetVersionId: input.renameScope?.datasetVersionId,
							},
							{ id: "rename-child" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Awaiting local review; no dataset change has been applied."),
			]);
		} else if (mode.startsWith("chart")) {
			const args = fauxConversationChart(input.chartScope);
			faux.setResponses([
				fauxAssistantMessage(
					[
						...(mode === "chart-mixed"
							? [
									fauxToolCall(
										"propose_column_rename",
										{ column: 0, name: "cohort", datasetVersionId: "v1" },
										{ id: "rename-child" },
									),
								]
							: []),
						fauxToolCall("propose_chart", args, { id: "chart-child" }),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					const ack = context.messages.at(-1);
					assert.equal(ack?.role, "toolResult");
					if (ack?.role !== "toolResult") throw new Error("Missing chart acknowledgement");
					assert.deepEqual(ack.content, [
						{
							type: "text",
							text: JSON.stringify({ status: "awaiting_review", toolCallId: "chart-child", applied: false }),
						},
					]);
					return mode === "chart-failure"
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "failure after chart proposal" })
						: fauxAssistantMessage(
								"Chart awaits local preview and explicit save or reject. No chart or dataset change has been applied.",
							);
				},
			]);
		} else {
			faux.setResponses([
				mode === "provider-error"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "secret-provider-error" })
					: fauxAssistantMessage("Real Pi child streaming response. ".repeat(mode === "cancel" ? 100 : 3)),
			]);
		}
		const result = await runConversationSession(input, emit, undefined, runtime);
		emit({ type: "result", ...result });
	} catch (error) {
		emit({ type: "error", code: error instanceof Error ? error.message : "provider" });
	}
}
