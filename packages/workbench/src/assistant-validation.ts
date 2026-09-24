import {
	ASSISTANT_ATTACHMENT_FILE_BYTES,
	ASSISTANT_ATTACHMENT_MAX_FILES,
	ASSISTANT_ATTACHMENT_TOTAL_BYTES,
	ASSISTANT_MAX_SUGGESTIONS,
	ASSISTANT_OUTPUT_BYTES,
	type AssistantAttachmentInput,
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
import type { TransformExpression } from "./transform-contracts.ts";
import { parseTransformSpec } from "./transform-spec.ts";

const SELECTION_KEYS = ["datasetVersionId", "selectedColumns", "filters", "request", "provider", "modelId"];
const OPTIONAL_SELECTION_KEYS = ["attachments", "executionIds"];
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

function selectionObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		SELECTION_KEYS.every((key) => Object.hasOwn(value, key)) &&
		Reflect.ownKeys(value).every(
			(key) => typeof key === "string" && (SELECTION_KEYS.includes(key) || OPTIONAL_SELECTION_KEYS.includes(key)),
		)
	);
}

function requireInput(condition: unknown, message: string, status = 400): asserts condition {
	if (!condition) throw new WorkbenchError(status, message);
}

function text(value: unknown, max: number, nonempty = true): value is string {
	return typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);
}

function expressionUsesDeclaredColumns(expression: TransformExpression, columns: number[]): boolean {
	switch (expression.kind) {
		case "column":
			return columns.includes(expression.column);
		case "literal":
			return true;
		case "binary":
			return (
				expressionUsesDeclaredColumns(expression.left, columns) &&
				expressionUsesDeclaredColumns(expression.right, columns)
			);
		case "call":
			return expression.args.every((argument) => expressionUsesDeclaredColumns(argument, columns));
	}
}

/** Keep the request and authorized filter values verbatim; only column order is canonicalized. */
export function parseAssistantSelection(value: unknown, dataset: Dataset): AssistantSelection {
	requireInput(selectionObject(value), "Provide only the required assistant selection fields.");
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
	let attachments: AssistantAttachmentInput[] | undefined;
	if (Object.hasOwn(value, "attachments")) {
		requireInput(
			Array.isArray(value.attachments) && value.attachments.length <= ASSISTANT_ATTACHMENT_MAX_FILES,
			"Attach at most eight text files of 8 KiB each, totaling 32 KiB.",
		);
		attachments = [];
		let totalBytes = 0;
		for (const attachment of value.attachments) {
			requireInput(
				objectWithKeys(attachment, ["name", "mediaType", "content"]) &&
					text(attachment.name, 256) &&
					attachment.name === attachment.name.trim() &&
					!/^[. ]|[. ]$|[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(attachment.name) &&
					!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(attachment.name) &&
					/\.(?:py|sql|txt|md|json)$/iu.test(attachment.name) &&
					attachment.mediaType === "text/plain" &&
					typeof attachment.content === "string" &&
					!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(attachment.content),
				"Attach only UTF-8 .py, .sql, .txt, .md or .json text files with safe basenames and text/plain media type.",
			);
			const byteLength = Buffer.byteLength(attachment.content, "utf8");
			totalBytes += byteLength;
			requireInput(
				byteLength <= ASSISTANT_ATTACHMENT_FILE_BYTES && totalBytes <= ASSISTANT_ATTACHMENT_TOTAL_BYTES,
				"Attach at most eight text files of 8 KiB each, totaling 32 KiB.",
			);
			attachments.push({ name: attachment.name, mediaType: attachment.mediaType, content: attachment.content });
		}
	}
	let executionIds: string[] | undefined;
	if (Object.hasOwn(value, "executionIds")) {
		requireInput(
			Array.isArray(value.executionIds) &&
				value.executionIds.length <= 8 &&
				!value.executionIds.includes(undefined) &&
				value.executionIds.every(
					(id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$(?![\s\S])/u.test(id),
				) &&
				new Set(value.executionIds).size === value.executionIds.length,
			"Select at most eight distinct controlled-operation results from this dataset.",
		);
		executionIds = [...value.executionIds];
	}
	return {
		datasetVersionId: dataset.currentVersionId,
		selectedColumns: dataset.schema.filter((column) => selected.has(column.index)).map((column) => column.index),
		filters,
		request: value.request,
		provider: value.provider,
		modelId: value.modelId,
		...(attachments === undefined ? {} : { attachments }),
		...(executionIds === undefined ? {} : { executionIds }),
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
		} else if (objectWithKeys(action, ["kind", "spec"]) && action.kind === "transform") {
			try {
				const spec = parseTransformSpec(action.spec, context.schema, context.dataset.versionId);
				const operation = spec.operation;
				const declared =
					"column" in operation
						? affectedColumns.includes(operation.column)
						: "columns" in operation
							? operation.columns.every((column) => affectedColumns.includes(column))
							: expressionUsesDeclaredColumns(operation.expression, affectedColumns);
				if (!declared) throw new Error("Transformation fields must be declared as affected columns.");
				proposedAction = { kind: "transform", spec };
			} catch {
				throw new WorkbenchError(
					422,
					"Assistant transformation must be a supported complete specification for the approved version and disclosed affected columns, including every nested expression reference. No code or implicit columns are allowed.",
				);
			}
		} else {
			requireInput(
				objectWithKeys(action, ["kind", "description"]) &&
					action.kind === "read-only" &&
					text(action.description, 1000),
				"Assistant actions must be validated chart or transformation proposals or read-only descriptions of at most 1000 characters.",
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
