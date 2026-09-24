import {
	CHART_MAX_MARKS,
	CHART_RESULT_BYTES,
	CHART_SAMPLE_CELLS,
	CHART_SAMPLE_ROWS,
	type ChartResult,
	type ChartSpec,
} from "./chart-contracts.ts";
import { parseChartSpec } from "./chart-spec.ts";
import type { DatasetColumn } from "./contracts.ts";
import type { ProfileInput } from "./profile-contracts.ts";

/** Only these fields may enter the bounded chart sample. Indexes retain source identity. */
export function chartColumns(spec: ChartSpec, schema: DatasetColumn[]): DatasetColumn[] {
	const indexes = new Set<number>();
	if (spec.type === "correlation")
		for (const column of schema.filter((column) => column.basicType === "number").slice(0, 12))
			indexes.add(column.index);
	if (spec.type === "missingness") for (const column of schema.slice(0, 24)) indexes.add(column.index);
	for (const index of [spec.x, spec.y, spec.color, spec.size, spec.facet]) if (index !== null) indexes.add(index);
	for (const filter of spec.filters) indexes.add(filter.column);
	if (indexes.size === 0) indexes.add(0);
	return schema.filter((column) => indexes.has(column.index));
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function nullableNumber(value: unknown): boolean {
	return value === null || finite(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length <= 1_048_576;
}
function nullableText(value: unknown): boolean {
	return value === null || text(value);
}

/** Reject malformed or wrong-version fixed-worker output before browser or export consumption. */
export function isChartResult(value: unknown, input: ProfileInput, spec: ChartSpec): value is ChartResult {
	if (!record(value) || !record(value.spec)) return false;
	try {
		if (
			JSON.stringify(parseChartSpec(value.spec, input.schema, input.datasetVersionId)) !==
			JSON.stringify(parseChartSpec(spec, input.schema, input.datasetVersionId))
		)
			return false;
	} catch {
		return false;
	}
	const columns = chartColumns(spec, input.schema);
	const capacity = Math.min(CHART_SAMPLE_ROWS, Math.floor(CHART_SAMPLE_CELLS / columns.length));
	if (
		value.datasetVersionHash !== input.datasetVersionHash ||
		value.populationRows !== input.rowCount ||
		!text(value.generatedAt) ||
		!Number.isFinite(Date.parse(value.generatedAt)) ||
		!count(value.sampleSize, Math.min(capacity, input.rowCount)) ||
		(input.rowCount > 0 && value.sampleSize === 0) ||
		value.stride !== Math.max(1, Math.ceil(input.rowCount / capacity)) ||
		typeof value.byteLimited !== "boolean" ||
		value.sampled !== value.sampleSize < input.rowCount ||
		!count(value.filteredRows, value.sampleSize) ||
		!count(value.excludedRows, value.sampleSize) ||
		!count(value.omittedMarks) ||
		!Array.isArray(value.marks) ||
		value.marks.length > CHART_MAX_MARKS ||
		!Array.isArray(value.warnings) ||
		value.warnings.length > 100 ||
		!value.warnings.every(text) ||
		!record(value.labels) ||
		!["x", "y", "color", "size", "facet", "aggregation", "filters", "missing"].every(
			(key) => record(value.labels) && text(value.labels[key]),
		) ||
		!record(value.table) ||
		!Array.isArray(value.table.columns) ||
		!Array.isArray(value.table.rows) ||
		value.table.rows.length > 100 ||
		JSON.stringify(value.table.columns) !== JSON.stringify(columns) ||
		Buffer.byteLength(JSON.stringify(value)) > CHART_RESULT_BYTES
	)
		return false;
	if (value.sampleSize !== Math.ceil(input.rowCount / (value.stride as number)) && !value.byteLimited) return false;
	const sampledRows = value.sampleSize;
	const stride = value.stride as number;
	const rowId = (id: unknown): id is number =>
		count(id, input.rowCount - 1) && id % stride === 0 && id / stride < sampledRows;
	if (
		!value.marks.every(
			(mark: unknown) =>
				record(mark) &&
				(text(mark.x) || finite(mark.x)) &&
				(text(mark.y) || finite(mark.y)) &&
				nullableNumber(mark.value) &&
				nullableText(mark.color) &&
				nullableText(mark.facet) &&
				[mark.size, mark.low, mark.high, mark.q1, mark.median, mark.q3].every(nullableNumber) &&
				Array.isArray(mark.rowIds) &&
				mark.rowIds.length <= sampledRows &&
				mark.rowIds.every(rowId) &&
				new Set(mark.rowIds).size === mark.rowIds.length,
		)
	)
		return false;
	const seen = new Set<number>();
	return value.table.rows.every((row: unknown) => {
		if (
			!record(row) ||
			!rowId(row.rowId) ||
			seen.has(row.rowId) ||
			!Array.isArray(row.values) ||
			row.values.length !== columns.length ||
			!row.values.every(nullableText)
		)
			return false;
		seen.add(row.rowId);
		return true;
	});
}
