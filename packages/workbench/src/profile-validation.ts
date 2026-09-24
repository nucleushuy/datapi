import { MAX_COLUMNS, MAX_TEMP_BYTES, MAX_UPLOAD_BYTES } from "./contracts.ts";
import {
	type DatasetProfile,
	PROFILE_REPORT_BYTES,
	PROFILE_SAMPLE_CELLS,
	PROFILE_SAMPLE_ROWS,
	PROFILER_VERSION,
	type ProfileInput,
} from "./profile-contracts.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function percentage(value: unknown, numerator: number, denominator: number): boolean {
	return denominator === 0
		? value === null
		: finite(value) && Math.abs(value - (numerator / denominator) * 100) <= 1e-9;
}
function strings(value: unknown, max: number): value is string[] {
	return Array.isArray(value) && value.length <= max && value.every((item: unknown) => typeof item === "string");
}
export function isProfileInput(value: unknown): value is ProfileInput {
	return (
		record(value) &&
		typeof value.datasetVersionId === "string" &&
		/^[a-zA-Z0-9_-]{1,80}$/u.test(value.datasetVersionId) &&
		typeof value.datasetVersionHash === "string" &&
		/^[a-f0-9]{64}$/u.test(value.datasetVersionHash) &&
		count(value.rowCount) &&
		count(value.sourceBytes, MAX_UPLOAD_BYTES) &&
		count(value.storageBytes, MAX_TEMP_BYTES) &&
		Array.isArray(value.schema) &&
		value.schema.length > 0 &&
		value.schema.length <= MAX_COLUMNS &&
		value.schema.every(
			(column: unknown, index: number) =>
				record(column) &&
				column.index === index &&
				typeof column.name === "string" &&
				typeof column.sourceType === "string" &&
				column.sourceType.length > 0 &&
				typeof column.basicType === "string" &&
				["empty", "number", "boolean", "text", "datetime", "binary", "nested"].includes(column.basicType),
		)
	);
}

/** Validate fixed-worker output and durable cached reports before either reaches the browser. */
export function isDatasetProfile(value: unknown, input: ProfileInput): value is DatasetProfile {
	if (
		!record(value) ||
		value.profilerVersion !== PROFILER_VERSION ||
		value.datasetVersionId !== input.datasetVersionId ||
		value.datasetVersionHash !== input.datasetVersionHash ||
		value.rowCount !== input.rowCount ||
		value.columnCount !== input.schema.length ||
		value.sourceBytes !== input.sourceBytes ||
		value.storageBytes !== input.storageBytes ||
		typeof value.profiledAt !== "string" ||
		!Number.isFinite(Date.parse(value.profiledAt)) ||
		!finite(value.estimatedMemoryBytes) ||
		value.estimatedMemoryBytes < 0 ||
		!record(value.sampling) ||
		!strings(value.limitations, 100) ||
		!Array.isArray(value.columns) ||
		value.columns.length !== input.schema.length ||
		!Array.isArray(value.issues) ||
		value.issues.length > 2048 ||
		Buffer.byteLength(JSON.stringify(value)) > PROFILE_REPORT_BYTES
	)
		return false;
	const sample = value.sampling;
	if (
		!count(
			sample.sampleSize,
			Math.min(input.rowCount, PROFILE_SAMPLE_ROWS, Math.floor(PROFILE_SAMPLE_CELLS / input.schema.length)),
		) ||
		sample.populationRows !== input.rowCount ||
		!count(sample.stride) ||
		sample.stride < 1 ||
		typeof sample.byteLimited !== "boolean" ||
		sample.approximate !== sample.sampleSize < input.rowCount ||
		sample.method !== (sample.approximate ? "systematic" : "full") ||
		(input.rowCount > 0 && sample.sampleSize === 0) ||
		!count(value.duplicateCount, Math.max(0, sample.sampleSize - 1))
	)
		return false;
	const size = sample.sampleSize;
	if (
		!value.columns.every((column: unknown, index: number) => {
			if (
				!record(column) ||
				column.index !== index ||
				column.name !== input.schema[index].name ||
				column.originalType !== input.schema[index].sourceType ||
				!count(column.nullCount, size) ||
				!count(column.emptyStringCount, size - column.nullCount) ||
				!count(column.distinctCount, size - column.nullCount) ||
				!percentage(column.nullPercentage, column.nullCount, size) ||
				!percentage(column.distinctPercentage, column.distinctCount, size - column.nullCount) ||
				!strings(column.examples, 10) ||
				!strings(column.limitations, 100) ||
				!Array.isArray(column.topValues) ||
				column.topValues.length > 10 ||
				!Array.isArray(column.semanticTypes) ||
				column.semanticTypes.length > 7
			)
				return false;
			if (
				!column.topValues.every(
					(entry: unknown) => record(entry) && typeof entry.label === "string" && count(entry.count, size),
				) ||
				!column.semanticTypes.every(
					(entry: unknown) =>
						record(entry) &&
						typeof entry.type === "string" &&
						["numeric", "categorical", "boolean", "datetime", "text", "identifier", "geographic"].includes(
							entry.type,
						) &&
						finite(entry.confidence) &&
						entry.confidence >= 0 &&
						entry.confidence <= 1 &&
						typeof entry.reason === "string",
				)
			)
				return false;
			if (column.numeric === null) return true;
			const numeric = column.numeric;
			return (
				record(numeric) &&
				count(numeric.count, size - column.nullCount - column.emptyStringCount) &&
				numeric.count > 0 &&
				count(numeric.excludedCount, size - column.nullCount - column.emptyStringCount - numeric.count) &&
				numeric.approximate === true &&
				finite(numeric.min) &&
				finite(numeric.max) &&
				numeric.min <= numeric.max &&
				finite(numeric.median) &&
				numeric.median >= numeric.min &&
				numeric.median <= numeric.max &&
				[numeric.mean, numeric.standardDeviation, numeric.skewness, numeric.lowerFence, numeric.upperFence].every(
					(entry) => entry === null || finite(entry),
				) &&
				(numeric.standardDeviation === null ||
					(finite(numeric.standardDeviation) && numeric.standardDeviation >= 0)) &&
				count(numeric.outlierCount, numeric.count) &&
				record(numeric.quantiles) &&
				[numeric.quantiles.p05, numeric.quantiles.p25, numeric.quantiles.p75, numeric.quantiles.p95].every(
					finite,
				) &&
				(numeric.quantiles.p05 as number) >= numeric.min &&
				(numeric.quantiles.p25 as number) >= (numeric.quantiles.p05 as number) &&
				numeric.median >= (numeric.quantiles.p25 as number) &&
				(numeric.quantiles.p75 as number) >= numeric.median &&
				(numeric.quantiles.p95 as number) >= (numeric.quantiles.p75 as number) &&
				(numeric.quantiles.p95 as number) <= numeric.max
			);
		})
	)
		return false;
	return value.issues.every(
		(issue: unknown) =>
			record(issue) &&
			typeof issue.id === "string" &&
			typeof issue.kind === "string" &&
			[
				"missing",
				"identifier",
				"target",
				"time",
				"constant",
				"high-cardinality",
				"leakage",
				"invalid-range",
				"inconsistent-category",
				"class-imbalance",
				"correlation",
				"outlier",
			].includes(issue.kind) &&
			typeof issue.severity === "string" &&
			["info", "warning", "error"].includes(issue.severity) &&
			Array.isArray(issue.columns) &&
			issue.columns.length > 0 &&
			issue.columns.length <= input.schema.length &&
			issue.columns.every((index: unknown) => count(index, input.schema.length - 1)) &&
			typeof issue.title === "string" &&
			typeof issue.proposedAction === "string" &&
			finite(issue.confidence) &&
			issue.confidence >= 0 &&
			issue.confidence <= 1 &&
			Array.isArray(issue.evidence) &&
			issue.evidence.length > 0 &&
			issue.evidence.length <= 20 &&
			issue.evidence.every(
				(evidence: unknown) =>
					record(evidence) &&
					typeof evidence.metric === "string" &&
					(evidence.value === null || typeof evidence.value === "string" || finite(evidence.value)) &&
					evidence.basis === (sample.approximate ? "sample" : "full") &&
					evidence.rows === size &&
					typeof evidence.approximate === "boolean" &&
					typeof evidence.detail === "string" &&
					(!sample.approximate || evidence.approximate),
			),
	);
}
