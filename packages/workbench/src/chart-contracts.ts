import type { DatasetColumn } from "./contracts.ts";

export const CHART_VERSION = 1;
export const CHART_SAMPLE_ROWS = 4096;
export const CHART_SAMPLE_CELLS = 200_000;
export const CHART_SAMPLE_BYTES = 16 * 1024 * 1024;
export const CHART_RESULT_BYTES = 4 * 1024 * 1024;
export const CHART_MAX_MARKS = 4096;
export const CHART_MAX_CATEGORIES = 30;
export const CHART_MAX_FACETS = 4;
export const CHART_TYPES = [
	"histogram",
	"box",
	"bar",
	"line",
	"scatter",
	"heatmap",
	"correlation",
	"missingness",
	"model-result",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export interface ChartFilter {
	column: number;
	op: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "is-null" | "not-null";
	value: string;
}
export interface ChartSpec {
	version: 1;
	datasetVersionId: string;
	type: ChartType;
	x: number | null;
	y: number | null;
	color: number | null;
	size: number | null;
	facet: number | null;
	aggregation: "count" | "sum" | "mean" | "median" | "none";
	sort: "ascending" | "descending" | "value-descending";
	filters: ChartFilter[];
	bins: number;
	categoryLimit: number;
	zeroBaseline: boolean;
	xMin: number | null;
	yMin: number | null;
}
export interface ChartRecord {
	id: string;
	projectId: string;
	datasetId: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	spec: ChartSpec;
}
export interface ChartMark {
	x: number | string;
	y: number | string;
	value: number | null;
	color: string | null;
	size: number | null;
	facet: string | null;
	low: number | null;
	high: number | null;
	q1: number | null;
	median: number | null;
	q3: number | null;
	rowIds: number[];
}
export interface ChartResult {
	spec: ChartSpec;
	datasetVersionHash: string;
	generatedAt: string;
	populationRows: number;
	sampleSize: number;
	stride: number;
	byteLimited: boolean;
	sampled: boolean;
	filteredRows: number;
	excludedRows: number;
	omittedMarks: number;
	marks: ChartMark[];
	table: { columns: DatasetColumn[]; rows: { rowId: number; values: (string | null)[] }[] };
	warnings: string[];
	labels: {
		x: string;
		y: string;
		color: string;
		size: string;
		facet: string;
		aggregation: string;
		filters: string;
		missing: string;
	};
}
export interface ChartSample {
	columns: DatasetColumn[];
	rows: { rowId: number; values: (string | null)[] }[];
	populationRows: number;
	stride: number;
	byteLimited: boolean;
}
export interface ChartRecommendation {
	type: ChartType;
	x: number | null;
	y: number | null;
	reason: string;
}
export interface ChartComparison {
	mode: "single" | "data-chart" | "chart-chart" | "filtered";
	left: ChartSpec;
	right: ChartSpec;
}
