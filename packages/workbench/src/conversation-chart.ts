import { ASSISTANT_OUTPUT_BYTES, type AssistantContext } from "./assistant-contracts.ts";
import { parseAssistantOutput } from "./assistant-validation.ts";
import { parseChartSpec } from "./chart-spec.ts";
import type { ChartProposalInput } from "./conversation-contracts.ts";
import { WorkbenchError } from "./storage.ts";

const INPUT_KEYS = ["toolCallId", "title", "explanation", "confidence", "evidenceRefs", "affectedColumns", "spec"];

/** Use the existing chart/evidence policy for typed Pi proposals; lifecycle fields remain server-owned. */
export function parseChartProposal(
	value: unknown,
	context: AssistantContext,
): ChartProposalInput & { basis: "evidence-linked" | "hypothesis" } {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).length !== INPUT_KEYS.length ||
		!INPUT_KEYS.every((key) => Object.hasOwn(value, key))
	)
		throw new WorkbenchError(400, "Chart proposal has missing or unsupported fields.");
	const input = value as Record<string, unknown>;
	if (
		typeof input.toolCallId !== "string" ||
		!input.toolCallId.trim() ||
		input.toolCallId.length > 256 ||
		input.toolCallId.includes("\0") ||
		typeof input.title !== "string" ||
		!input.title.trim() ||
		input.title.length > 120 ||
		/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(input.title)
	)
		throw new WorkbenchError(400, "Use a valid chart tool identifier and a chart title up to 120 characters.");
	let source: string;
	try {
		const spec = parseChartSpec(input.spec, context.schema, context.dataset.versionId);
		source = JSON.stringify({
			summary: "",
			suggestions: [
				{
					id: "chart-proposal",
					category: "visualization",
					title: input.title,
					explanation: input.explanation,
					priority: "medium",
					confidence: input.confidence,
					evidenceRefs: input.evidenceRefs,
					affectedColumns: input.affectedColumns,
					proposedAction: { kind: "chart", spec },
					generatedCode: null,
				},
			],
		});
	} catch {
		throw new WorkbenchError(400, "Chart proposal must contain serializable data.");
	}
	if (Buffer.byteLength(source) > ASSISTANT_OUTPUT_BYTES)
		throw new WorkbenchError(400, "Chart proposal exceeds the response limit.");
	const suggestion = parseAssistantOutput(source, context).suggestions[0];
	if (suggestion.proposedAction.kind !== "chart" || suggestion.proposedAction.spec.type === "model-result")
		throw new WorkbenchError(400, "Propose a supported data chart, not an untrained model result.");
	return {
		toolCallId: input.toolCallId,
		title: suggestion.title,
		explanation: suggestion.explanation,
		confidence: suggestion.confidence,
		evidenceRefs: suggestion.evidenceRefs,
		affectedColumns: suggestion.affectedColumns,
		spec: suggestion.proposedAction.spec,
		basis: suggestion.basis,
	};
}
