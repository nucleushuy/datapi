import {
	ASSISTANT_MAX_SUGGESTIONS,
	ASSISTANT_OUTPUT_BYTES,
	type AssistantContext,
	type AssistantOutput,
	type AssistantSelection,
	type AssistantSuggestion,
	SUGGESTION_CATEGORIES,
} from "./assistant-contracts.ts";
import { defaultChartSpec, parseChartSpec } from "./chart-spec.ts";
import { chartColumns } from "./chart-validation.ts";
import type { Dataset } from "./contracts.ts";
import { WorkbenchError } from "./storage.ts";

const SELECTION_KEYS = ["datasetVersionId", "selectedColumns", "filters", "request", "provider", "modelId"];
const SUGGESTION_KEYS = [
	"id",
	"category",
	"title",
	"explanation",
	"priority",
	"confidence",
	"evidenceRefs",
	"affectedColumns",
	"proposedAction",
	"generatedCode",
];

function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function requireInput(condition: unknown, message: string, status = 400): asserts condition {
	if (!condition) throw new WorkbenchError(status, message);
}

function text(value: unknown, max: number, nonempty = true): value is string {
	return typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);
}

/** Keep the request and authorized filter values verbatim; only column order is canonicalized. */
export function parseAssistantSelection(value: unknown, dataset: Dataset): AssistantSelection {
	requireInput(objectWithKeys(value, SELECTION_KEYS), "Provide only the required assistant selection fields.");
	requireInput(
		value.datasetVersionId === dataset.currentVersionId,
		"The dataset version changed. Prepare a new assistant request.",
		409,
	);
	requireInput(text(value.request, 4000), "Assistant requests must contain 1 to 4000 characters.");
	requireInput(
		text(value.provider, 128) && /^[a-zA-Z0-9_-]+$(?![\s\S])/u.test(value.provider),
		"Choose a valid assistant provider.",
	);
	requireInput(
		text(value.modelId, 256) && !/[\u0000-\u001f\u007f]/u.test(value.modelId),
		"Choose a valid assistant model.",
	);
	const indexes = new Set(dataset.schema.map((column) => column.index));
	requireInput(
		Array.isArray(value.selectedColumns) &&
			value.selectedColumns.length <= 32 &&
			value.selectedColumns.every((index: unknown) => typeof index === "number" && indexes.has(index)) &&
			new Set(value.selectedColumns).size === value.selectedColumns.length,
		"Select at most 32 distinct columns from the current dataset.",
	);
	let filters: AssistantSelection["filters"];
	try {
		filters = parseChartSpec(
			{ ...defaultChartSpec(dataset.currentVersionId), filters: value.filters },
			dataset.schema,
			dataset.currentVersionId,
		).filters;
	} catch {
		throw new WorkbenchError(400, "Assistant filters must be at most 8 valid current-dataset chart filters.");
	}
	const selected = new Set(value.selectedColumns);
	return {
		datasetVersionId: dataset.currentVersionId,
		selectedColumns: dataset.schema.filter((column) => selected.has(column.index)).map((column) => column.index),
		filters,
		request: value.request,
		provider: value.provider,
		modelId: value.modelId,
	};
}

/** Parse exactly one JSON object. Model-owned lifecycle state, unknown options and partial output are rejected. */
export function parseAssistantOutput(source: string, context: AssistantContext): AssistantOutput {
	requireInput(
		typeof source === "string" && Buffer.byteLength(source, "utf8") <= ASSISTANT_OUTPUT_BYTES,
		"Assistant output exceeds the 128 KiB limit. No suggestions were accepted.",
		422,
	);
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new WorkbenchError(
			422,
			"Assistant output must be one complete JSON object without code fences or extra text.",
		);
	}
	const invalid = "Assistant output has missing, unsupported or invalid fields. No suggestions were accepted.";
	requireInput(objectWithKeys(value, ["summary", "suggestions"]), invalid, 422);
	requireInput(text(value.summary, 4000, false), "Assistant summary must be text of at most 4000 characters.", 422);
	requireInput(
		Array.isArray(value.suggestions) && value.suggestions.length <= ASSISTANT_MAX_SUGGESTIONS,
		"Assistant output must contain at most 12 suggestions.",
		422,
	);
	const disclosedColumns = new Set(context.schema.map((column) => column.index));
	const evidence = new Map(context.evidence.map((record) => [record.id, record]));
	const ids = new Set<string>();
	const suggestions = value.suggestions.map((suggestion: unknown): AssistantSuggestion => {
		requireInput(objectWithKeys(suggestion, SUGGESTION_KEYS), invalid, 422);
		requireInput(
			typeof suggestion.id === "string" &&
				/^[a-zA-Z0-9_-]{1,80}$(?![\s\S])/u.test(suggestion.id) &&
				!ids.has(suggestion.id),
			"Assistant suggestion identifiers must be unique safe identifiers of at most 80 characters.",
			422,
		);
		ids.add(suggestion.id);
		requireInput(
			SUGGESTION_CATEGORIES.some((category) => category === suggestion.category) &&
				["low", "medium", "high"].some((priority) => priority === suggestion.priority) &&
				text(suggestion.title, 160) &&
				text(suggestion.explanation, 4000) &&
				typeof suggestion.confidence === "number" &&
				Number.isFinite(suggestion.confidence) &&
				suggestion.confidence >= 0 &&
				suggestion.confidence <= 1,
			invalid,
			422,
		);
		requireInput(
			Array.isArray(suggestion.affectedColumns) &&
				suggestion.affectedColumns.length <= 32 &&
				suggestion.affectedColumns.every(
					(index: unknown) => typeof index === "number" && disclosedColumns.has(index),
				) &&
				new Set(suggestion.affectedColumns).size === suggestion.affectedColumns.length,
			"Assistant suggestions may reference at most 32 distinct disclosed columns.",
			422,
		);
		const affectedColumns = suggestion.affectedColumns as number[];
		requireInput(
			Array.isArray(suggestion.evidenceRefs) &&
				suggestion.evidenceRefs.length <= 32 &&
				suggestion.evidenceRefs.every((id: unknown) => typeof id === "string" && evidence.has(id)) &&
				new Set(suggestion.evidenceRefs).size === suggestion.evidenceRefs.length,
			"Assistant evidence references must cite distinct exact records from the approved context.",
			422,
		);
		const evidenceRefs = suggestion.evidenceRefs as string[];
		requireInput(
			evidenceRefs.every((id) => evidence.get(id)!.columns.every((index) => affectedColumns.includes(index))),
			"Assistant evidence references must concern the suggestion's affected columns.",
			422,
		);
		let proposedAction: AssistantSuggestion["proposedAction"];
		const action = suggestion.proposedAction;
		if (objectWithKeys(action, ["kind", "spec"]) && action.kind === "chart") {
			try {
				const spec = parseChartSpec(action.spec, context.schema, context.dataset.versionId);
				if (
					(spec.type === "correlation" || spec.type === "missingness") &&
					context.schema.length !== context.dataset.columnCount
				)
					throw new Error("Automatic field selection requires complete disclosure.");
				if (!chartColumns(spec, context.schema).every((column) => affectedColumns.includes(column.index)))
					throw new Error("Chart fields must be declared as affected columns.");
				proposedAction = { kind: "chart", spec };
			} catch {
				throw new WorkbenchError(
					422,
					"Assistant chart must be a supported complete specification for the approved version and disclosed affected columns; dual axes and undisclosed automatic fields are not allowed.",
				);
			}
		} else {
			requireInput(
				objectWithKeys(action, ["kind", "description"]) &&
					action.kind === "read-only" &&
					text(action.description, 1000),
				"Assistant actions must be validated chart proposals or read-only descriptions of at most 1000 characters.",
				422,
			);
			proposedAction = { kind: "read-only", description: action.description };
		}
		requireInput(
			suggestion.generatedCode === null || text(suggestion.generatedCode, 16_384, false),
			"Assistant generated code must be null or display-only text of at most 16384 characters.",
			422,
		);
		return {
			id: suggestion.id,
			category: suggestion.category as AssistantSuggestion["category"],
			title: suggestion.title,
			explanation: suggestion.explanation,
			priority: suggestion.priority as AssistantSuggestion["priority"],
			confidence: evidenceRefs.length ? suggestion.confidence : Math.min(0.5, suggestion.confidence),
			evidenceRefs,
			affectedColumns,
			proposedAction,
			generatedCode: suggestion.generatedCode,
			status: "proposed",
			basis: evidenceRefs.length ? "evidence-linked" : "hypothesis",
			chartId: null,
			error: null,
		};
	});
	return { summary: value.summary, suggestions };
}
