import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetColumn } from "../src/contracts.ts";
import { computeDatasetProfile } from "../src/dataset-profiler.ts";
import type { ProfileInput } from "../src/profile-contracts.ts";
import { isDatasetProfile } from "../src/profile-validation.ts";

function report(
	names: string[],
	rows: (string | null)[][],
	population = rows.length,
	types?: DatasetColumn["basicType"][],
) {
	const input: ProfileInput = {
		datasetVersionId: "fixture",
		datasetVersionHash: "a".repeat(64),
		rowCount: population,
		sourceBytes: 100,
		storageBytes: 1000,
		schema: names.map((name, index) => ({ index, name, sourceType: "VARCHAR", basicType: types?.[index] ?? "text" })),
	};
	const approximate = rows.length < population;
	const value = computeDatasetProfile(
		input,
		rows,
		{
			method: approximate ? "systematic" : "full",
			populationRows: population,
			sampleSize: rows.length,
			stride: Math.max(1, Math.ceil(population / Math.max(1, rows.length))),
			byteLimited: false,
			approximate,
		},
		"2026-09-24T00:00:00.000Z",
	);
	assert.ok(isDatasetProfile(value, input), "Generated report must satisfy the worker/cache boundary");
	return value;
}
function near(actual: number | null | undefined, expected: number) {
	assert.equal(typeof actual, "number");
	assert.ok(Math.abs(actual! - expected) < 1e-10, `${actual} versus ${expected}`);
}

test("numeric statistics use R7 quantiles, sample deviation and adjusted skewness", () => {
	const numeric = report(
		["value"],
		[1, 2, 3, 4, 5].map((n) => [String(n)]),
	).columns[0].numeric;
	assert.ok(numeric);
	assert.equal(numeric.count, 5);
	assert.equal(numeric.min, 1);
	assert.equal(numeric.max, 5);
	near(numeric.mean, 3);
	near(numeric.median, 3);
	near(numeric.standardDeviation, Math.sqrt(2.5));
	near(numeric.skewness, 0);
	near(numeric.quantiles.p05, 1.2);
	near(numeric.quantiles.p25, 2);
	near(numeric.quantiles.p75, 4);
	near(numeric.quantiles.p95, 4.8);
	assert.equal(numeric.approximate, true);
	const skewed = report(
		["value"],
		[1, 1, 1, 1, 100].map((n) => [String(n)]),
	);
	assert.equal(skewed.columns[0].numeric?.outlierCount, 1);
	near(skewed.columns[0].numeric?.skewness, Math.sqrt(5));
	assert.ok(skewed.issues.some((issue) => issue.kind === "outlier"));
});

test("empty singleton constant and mixed values retain undefined and exclusion semantics", () => {
	assert.equal(report(["value"], []).columns[0].numeric, null);
	const singleton = report(["value"], [["3"]]).columns[0].numeric;
	assert.equal(singleton?.standardDeviation, null);
	assert.equal(singleton?.skewness, null);
	const constant = report(["value"], [["3"], ["3"], ["3"]]);
	assert.equal(constant.columns[0].numeric?.standardDeviation, 0);
	assert.equal(constant.columns[0].numeric?.skewness, null);
	assert.equal(constant.duplicateCount, 2);
	assert.ok(constant.issues.some((issue) => issue.kind === "constant"));
	const mixed = report(
		["value"],
		[[null], [""], [" "], ["1"], ["3"], ["0x10"], ["NaN"], ["1e-999"], ["9007199254740993"]],
	).columns[0];
	assert.equal(mixed.numeric?.count, 2);
	assert.equal(mixed.numeric?.excludedCount, 5);
	near(mixed.numeric?.mean, 2);
	assert.equal(mixed.nullCount, 1);
	assert.equal(mixed.emptyStringCount, 1);
});

test("nulls empty strings distinct values and redacted examples stay separate", () => {
	const value = report(
		["category"],
		[[null], [""], ["private@example.com"], ["private@example.com"], ["another-secret"]],
	);
	const column = value.columns[0];
	assert.equal(column.nullCount, 1);
	assert.equal(column.nullPercentage, 20);
	assert.equal(column.emptyStringCount, 1);
	assert.equal(column.distinctCount, 3);
	assert.equal(column.distinctPercentage, 75);
	assert.equal(value.duplicateCount, 1);
	assert.equal(column.topValues[0].count, 2);
	assert.equal(new Set(column.examples).size, 3);
	assert.doesNotMatch(JSON.stringify(value), /private@example|another-secret/);
	assert.ok(value.issues.some((issue) => issue.kind === "missing"));
});

test("semantic inference recognizes all candidate kinds without coercing nested values or invalid dates", () => {
	const value = report(
		["customer_id", "amount", "flag", "created_at", "latitude", "description", "nested", "bad_date"],
		[
			["001", "2", "true", "2024-02-29", "40", "long sentence", "123", "2023-02-29"],
			["002", "3", "false", "2024-03-01T12:30:00Z", "100", "different sentence", "456", "2024-13-01"],
		],
		2,
		["text", "number", "boolean", "datetime", "number", "text", "nested", "text"],
	);
	const types = (index: number) => value.columns[index].semanticTypes.map((candidate) => candidate.type);
	assert.ok(types(0).includes("identifier"));
	assert.ok(types(1).includes("numeric"));
	assert.ok(types(2).includes("boolean"));
	assert.ok(types(3).includes("datetime"));
	assert.ok(types(4).includes("geographic"));
	assert.ok(types(5).includes("text"));
	assert.ok(types(5).includes("categorical"));
	assert.deepEqual(types(6), []);
	assert.equal(value.columns[6].numeric, null);
	assert.ok(!types(7).includes("datetime"));
	assert.ok(value.issues.some((issue) => issue.kind === "time"));
	const range = value.issues.find((issue) => issue.kind === "invalid-range");
	assert.equal(range?.evidence[0].value, 1);
});

test("quality rules expose targets imbalance variants correlations leakage and exact scoped evidence", () => {
	const value = report(
		["id", "amount", "copy", "target", "category", "constant", "age"],
		Array.from({ length: 40 }, (_, i) => [
			String(i),
			String(i * 2),
			String(i * 2),
			i === 0 ? "rare" : "common",
			i % 2 ? "A" : " a ",
			"fixed",
			i === 0 ? "-1" : "30",
		]),
	);
	for (const kind of [
		"identifier",
		"high-cardinality",
		"target",
		"class-imbalance",
		"inconsistent-category",
		"correlation",
		"constant",
		"invalid-range",
	])
		assert.ok(
			value.issues.some((issue) => issue.kind === kind),
			kind,
		);
	const leakage = report(
		["target", "copied_outcome"],
		[
			["red", "red"],
			["blue", "blue"],
			["green", "green"],
		],
	);
	assert.ok(leakage.issues.some((issue) => issue.kind === "leakage"));
	for (const issue of value.issues) {
		assert.ok(issue.proposedAction.length > 0);
		assert.ok(issue.confidence >= 0 && issue.confidence <= 1);
		for (const evidence of issue.evidence) {
			assert.equal(evidence.basis, "full");
			assert.equal(evidence.rows, 40);
		}
	}
});

test("sampled reports do not claim population counts or exact evidence", () => {
	const rows = [
		["1", "A"],
		["1", "a"],
		["2", null],
	];
	const sample = report(["id", "category"], rows, 100);
	assert.equal(sample.rowCount, 100);
	assert.equal(sample.duplicateCount, 0);
	assert.equal(sample.columns[0].distinctCount, 2);
	assert.equal(sample.sampling.approximate, true);
	for (const issue of sample.issues)
		for (const evidence of issue.evidence) {
			assert.equal(evidence.basis, "sample");
			assert.equal(evidence.rows, 3);
			assert.equal(evidence.approximate, true);
		}
	assert.deepEqual(report(["id", "category"], rows, 100), sample);
});

test("wide reports explicitly bound findings and correlation work", () => {
	const names = Array.from({ length: 40 }, (_, i) => `x${i}`);
	const value = report(
		names,
		Array.from({ length: 10 }, (_, i) => names.map(() => String(i))),
	);
	assert.ok(value.issues.length <= 128);
	assert.ok(
		value.issues
			.filter((issue) => issue.kind === "correlation")
			.every((issue) => issue.columns.every((column) => column < 24)),
	);
	assert.ok(value.limitations.some((limitation) => limitation.includes("24") && limitation.includes("40 eligible")));
	assert.ok(value.limitations.some((limitation) => /omitted/.test(limitation)));
});
