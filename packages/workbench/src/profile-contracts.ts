import type { DatasetColumn } from "./contracts.ts";

export const PROFILER_VERSION = 1;
export const PROFILE_SAMPLE_ROWS = 4096;
export const PROFILE_SAMPLE_CELLS = 200_000;
export const PROFILE_SAMPLE_BYTES = 16 * 1024 * 1024;
export const PROFILE_REPORT_BYTES = 4 * 1024 * 1024;
export const PROFILE_REQUEST_BYTES = 2 * 1024 * 1024;

export type SemanticType = "numeric" | "categorical" | "boolean" | "datetime" | "text" | "identifier" | "geographic";
export interface Evidence {
	metric: string;
	value: number | string | null;
	basis: "full" | "sample";
	rows: number;
	approximate: boolean;
	detail: string;
}
export interface DataIssue {
	id: string;
	kind:
		| "missing"
		| "identifier"
		| "target"
		| "time"
		| "constant"
		| "high-cardinality"
		| "leakage"
		| "invalid-range"
		| "inconsistent-category"
		| "class-imbalance"
		| "correlation"
		| "outlier";
	severity: "info" | "warning" | "error";
	columns: number[];
	title: string;
	confidence: number;
	evidence: Evidence[];
	proposedAction: string;
}
export interface ColumnProfile {
	index: number;
	name: string;
	originalType: string;
	semanticTypes: { type: SemanticType; confidence: number; reason: string }[];
	nullCount: number;
	nullPercentage: number | null;
	emptyStringCount: number;
	distinctCount: number;
	distinctPercentage: number | null;
	examples: string[];
	topValues: { label: string; count: number }[];
	numeric: null | {
		count: number;
		excludedCount: number;
		min: number;
		max: number;
		mean: number | null;
		median: number;
		standardDeviation: number | null;
		quantiles: { p05: number; p25: number; p75: number; p95: number };
		skewness: number | null;
		outlierCount: number;
		lowerFence: number | null;
		upperFence: number | null;
		approximate: true;
	};
	limitations: string[];
}
export interface DatasetProfile {
	profilerVersion: number;
	datasetVersionId: string;
	datasetVersionHash: string;
	profiledAt: string;
	rowCount: number;
	columnCount: number;
	sourceBytes: number;
	storageBytes: number;
	estimatedMemoryBytes: number;
	duplicateCount: number;
	sampling: {
		method: "full" | "systematic";
		populationRows: number;
		sampleSize: number;
		stride: number;
		byteLimited: boolean;
		approximate: boolean;
	};
	columns: ColumnProfile[];
	issues: DataIssue[];
	limitations: string[];
}

export interface ProfileInput {
	datasetVersionId: string;
	datasetVersionHash: string;
	rowCount: number;
	sourceBytes: number;
	storageBytes: number;
	schema: DatasetColumn[];
}

export interface ProfileResponse {
	profile: DatasetProfile | null;
}
