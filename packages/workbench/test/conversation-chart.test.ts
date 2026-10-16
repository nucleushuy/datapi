import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantContext } from "../src/assistant-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import { parseChartProposal } from "../src/conversation-chart.ts";
import type { ChartProposalInput } from "../src/conversation-contracts.ts";
import { WorkbenchError } from "../src/storage.ts";

const context: AssistantContext = {
	version: 1,
	project: { id: "project", name: "Fixture", description: "" },
	dataset: {
		id: "dataset",
		name: "Fixture",
		versionId: "v1",
		artifactHash: "a".repeat(64),
		rowCount: 100,
		columnCount: 3,
	},
	schema: [
		{ index: 0, name: "group", sourceType: "VARCHAR", basicType: "text" },
		{ index: 2, name: "value", sourceType: "DOUBLE", basicType: "number" },
	],
	selectedColumns: [0, 2],
	filters: [],
	artifacts: [],
	limitations: [],
	rowsIncluded: false,
	evidence: [
		{
			id: "column.0.distinctCount",
			metric: "distinctCount",
			value: 3,
			columns: [0],
			basis: "sample",
			rows: 20,
			approximate: true,
		},
	],
};
const input: ChartProposalInput = {
	toolCallId: "tool-call",
	title: "Counts by group",
	explanation: "Sampled distinct counts suggest grouping; local preview will calculate counts.",
	confidence: 0.8,
	evidenceRefs: ["column.0.distinctCount"],
	affectedColumns: [0],
	spec: { ...defaultChartSpec("v1"), x: 0 },
};

test("chart proposal keeps evidence-linked inference and caps uncited confidence", () => {
	const proposal = parseChartProposal(input, context);
	assert.deepEqual(proposal, { ...input, basis: "evidence-linked" });
	const hypothesis = parseChartProposal({ ...input, evidenceRefs: [] }, context);
	assert.equal(hypothesis.basis, "hypothesis");
	assert.equal(hypothesis.confidence, 0.5);
	assert.equal("status" in proposal, false);
	assert.equal("chartId" in proposal, false);
	assert.equal("preview" in proposal, false);
});

test("chart proposals reject lifecycle forgery, hidden fields, invented evidence and invalid chart controls", () => {
	for (const value of [
		{ ...input, state: "saved" },
		{ ...input, basis: "evidence-linked" },
		{ ...input, toolCallId: "\0" },
		{ ...input, title: "\u202eforged" },
		{ ...input, title: "x".repeat(121) },
		{ ...input, evidenceRefs: ["invented"] },
		{ ...input, evidenceRefs: ["column.0.distinctCount", "column.0.distinctCount"] },
		{ ...input, affectedColumns: [2] },
		{ ...input, affectedColumns: [0, 0] },
		{ ...input, spec: { ...input.spec, x: 1 } },
		{ ...input, spec: { ...input.spec, filters: [{ column: 1, op: "eq", value: "private" }] } },
		{ ...input, spec: { ...input.spec, datasetVersionId: "v2" } },
		{ ...input, spec: { ...input.spec, yAxis: "right" } },
		{ ...input, spec: { ...input.spec, yMin: Infinity } },
		{ ...input, spec: { ...input.spec, yMin: NaN } },
		{ ...input, spec: { ...input.spec, [Symbol("hidden")]: true } },
		{ ...input, spec: { ...input.spec, type: "missingness", x: null, aggregation: "none" } },
		{ ...input, spec: { ...input.spec, type: "model-result", x: null, aggregation: "none" } },
	])
		assert.throws(() => parseChartProposal(value, context), WorkbenchError);
});

test("chart proposals preserve original noncontiguous indexes, filters and untrusted display text", () => {
	const proposal = parseChartProposal(
		{
			...input,
			title: "<img src=x onerror=alert(1)>",
			explanation: "<script>not executed</script>",
			spec: {
				...input.spec,
				type: "histogram",
				x: 2,
				filters: [{ column: 0, op: "eq", value: "<script>data</script>" }],
			},
			affectedColumns: [0, 2],
		},
		context,
	);
	assert.equal(proposal.spec.x, 2);
	assert.equal(proposal.spec.filters[0].value, "<script>data</script>");
	assert.equal(proposal.title, "<img src=x onerror=alert(1)>");
	assert.equal(proposal.explanation, "<script>not executed</script>");
});
