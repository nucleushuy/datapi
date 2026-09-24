import type { ColumnProfile, DatasetColumn } from "./contracts.ts";

export const TRANSFORM_VERSION = 1;
export const TRANSFORM_PREVIEW_ROWS = 20;
export const TRANSFORM_RESULT_BYTES = 4 * 1024 * 1024;
export const TRANSFORM_SPEC_BYTES = 24 * 1024;
export const TRANSFORM_MAX_VERSIONS = 100;
export const TRANSFORM_DRAFT_TTL_MS = 10 * 60_000;

/** An expression tree, never source code. Column references use input schema indexes. */
export type TransformExpression =
	| { kind: "column"; column: number }
	| { kind: "literal"; value: string | number | null }
	| {
			kind: "binary";
			operator: "add" | "subtract" | "multiply" | "divide";
			left: TransformExpression;
			right: TransformExpression;
	  }
	| {
			kind: "call";
			function: "abs" | "round" | "lower" | "upper" | "trim" | "length" | "coalesce";
			args: TransformExpression[];
	  };

export type TransformOperation =
	| { kind: "rename"; column: number; name: string }
	| {
			kind: "cast";
			column: number;
			type: "text" | "number" | "integer" | "boolean" | "date" | "timestamp";
			invalid: "error" | "null";
	  }
	| { kind: "drop"; columns: number[] }
	| {
			kind: "filter";
			column: number;
			operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "is-null" | "not-null";
			comparison: "text" | "number";
			value: string | null;
	  }
	| {
			kind: "missing";
			columns: number[];
			method: "constant" | "mean" | "median" | "drop";
			missing: "null" | "empty" | "both";
			value: string | null;
	  }
	| { kind: "deduplicate"; columns: number[] }
	| { kind: "map"; column: number; entries: { from: string; to: string | null }[]; unmatched: "keep" | "null" }
	| { kind: "datetime"; column: number; component: "year" | "month" | "day" | "weekday" | "hour"; name: string }
	| { kind: "scale"; column: number; method: "standard" | "minmax"; name: string }
	| { kind: "encode"; column: number; method: "ordinal" | "one-hot"; categories: string[]; name: string }
	| { kind: "derive"; name: string; expression: TransformExpression };

export interface TransformSpec {
	version: 1;
	datasetVersionId: string;
	operation: TransformOperation;
}

export interface TransformFacts {
	rowCount: number;
	schema: DatasetColumn[];
	columns: ColumnProfile[];
}

export interface TransformImpact extends TransformFacts {
	inputVersionId: string;
	inputHash: string;
	spec: TransformSpec;
	engineVersion: string;
	/** Application-generated DuckDB SQL using the immutable input's internal cN columns. */
	sql: string;
	affectedRows: number;
	inputRows: number;
	nullChanges: { name: string; before: number | null; after: number | null }[];
	schemaBefore: DatasetColumn[];
	/** First bounded input/output rows in deterministic row order, not an aligned diff. */
	before: (string | null)[][];
	after: (string | null)[][];
	warnings: string[];
}

export interface TransformPreview {
	id: string;
	projectId: string;
	datasetId: string;
	createdAt: string;
	expiresAt: string;
	impact: TransformImpact;
}

export interface TransformRecord {
	id: string;
	projectId: string;
	datasetId: string;
	actor: "local-user";
	createdAt: string;
	completedAt: string | null;
	inputVersionId: string;
	outputVersionId: string | null;
	spec: TransformSpec;
	state: "previewed" | "applied" | "failed" | "cancelled" | "expired";
	result: TransformImpact | null;
	error: string | null;
}

export interface TransformHistory {
	currentVersionId: string;
	canUndo: boolean;
	canRedo: boolean;
	records: TransformRecord[];
}
