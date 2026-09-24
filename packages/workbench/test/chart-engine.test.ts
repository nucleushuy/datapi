import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHART_MAX_MARKS,
	CHART_RESULT_BYTES,
	type ChartFilter,
	type ChartSample,
	type ChartSpec,
} from "../src/chart-contracts.ts";
import { computeChart } from "../src/chart-engine.ts";
import { defaultChartSpec, parseChartSpec } from "../src/chart-spec.ts";
import type { DatasetColumn } from "../src/contracts.ts";

function sample(
	rows: (string | null)[][],
	types?: DatasetColumn["basicType"][],
	indexes?: number[],
	stride = 1,
): ChartSample {
	const count = types?.length ?? indexes?.length ?? rows[0]?.length ?? 0;
	return {
		columns: Array.from({ length: count }, (_, index) => ({
			index: indexes?.[index] ?? index,
			name: `field${indexes?.[index] ?? index}`,
			sourceType: "VARCHAR",
			basicType: types?.[index] ?? "text",
		})),
		rows: rows.map((values, index) => ({ rowId: index * stride, values })),
		populationRows: rows.length * stride,
		stride,
		byteLimited: false,
	};
}
function chart(input: ChartSample, changes: Partial<ChartSpec> = {}) {
	const spec = parseChartSpec({ ...defaultChartSpec("fixture"), ...changes }, input.columns, "fixture");
	return computeChart(spec, input, "a".repeat(64), "2026-09-24T00:00:00.000Z");
}
function near(actual: number | null, expected: number) {
	assert.equal(typeof actual, "number");
	assert.ok(Math.abs(actual! - expected) < 1e-10, `${actual} versus ${expected}`);
}
function hasWarning(result: ReturnType<typeof chart>, pattern: RegExp) {
	assert.ok(
		result.warnings.some((warning) => pattern.test(warning)),
		`Expected warning ${pattern}`,
	);
}

test("histograms include the maximum and retain linked memberships with finite degenerate ranges", () => {
	const input = sample([["0"], ["1"], ["2"], ["3"], ["4"], ["5"], [null], [""], ["0x10"]], ["number"], [7], 3);
	const result = chart(input, { type: "histogram", x: 7, bins: 5 });
	assert.deepEqual(
		result.marks.map((mark) => [mark.low, mark.high, mark.value]),
		[
			[0, 1, 1],
			[1, 2, 1],
			[2, 3, 1],
			[3, 4, 1],
			[4, 5, 2],
		],
	);
	assert.deepEqual(result.marks[4].rowIds, [12, 15]);
	assert.equal(result.excludedRows, 3);
	assert.equal(result.filteredRows, 9);
	assert.equal(result.populationRows, 27);
	hasWarning(result, /sample/i);
	const constant = chart(sample([["2"], ["2"]], ["number"]), { type: "histogram", x: 0 });
	assert.deepEqual(
		constant.marks.map((mark) => [mark.low, mark.high, mark.value]),
		[[2, 2, 2]],
	);
	const tiny = chart(sample([["5e-324"], ["1e-323"]], ["number"]), { type: "histogram", x: 0, bins: 100 });
	assert.equal(tiny.marks.length, 1);
	assert.equal(tiny.marks[0].value, 2);
	assert.ok(tiny.marks.every((mark) => Number.isFinite(mark.low) && Number.isFinite(mark.high)));
});

test("box plots use R7 quartiles and Tukey observed whiskers but retain outlier memberships", () => {
	const input = sample(
		[1, 2, 3, 4, 100].map((number) => ["A", String(number)]),
		["text", "number"],
	);
	const result = chart(input, { type: "box", x: 0, y: 1, aggregation: "none" });
	assert.equal(result.marks.length, 1);
	const mark = result.marks[0];
	assert.deepEqual([mark.x, mark.q1, mark.median, mark.q3, mark.low, mark.high], ['"A"', 2, 3, 4, 1, 4]);
	assert.deepEqual(mark.rowIds, [0, 1, 2, 3, 4]);
	assert.equal(result.excludedRows, 0);
	hasWarning(result, /outside box whiskers/);
	const singleton = chart(sample([["5"]], ["number"]), { type: "box", y: 0, aggregation: "none" });
	assert.deepEqual([singleton.marks[0].q1, singleton.marks[0].median, singleton.marks[0].q3], [5, 5, 5]);
});

test("bar aggregates filter first, map original indexes, and distinguish NULL from empty and literal labels", () => {
	const input = sample(
		[
			[null, "1"],
			["", "2"],
			["NULL", "3"],
			["A", "2"],
			["A", "4"],
			["A", "9007199254740993"],
		],
		["text", "number"],
		[3, 9],
	);
	const count = chart(input, { x: 3 });
	assert.deepEqual(new Set(count.marks.map((mark) => mark.x)), new Set(["NULL", '""', '"NULL"', '"A"']));
	assert.equal(count.marks.find((mark) => mark.x === '"A"')?.value, 3);
	for (const [aggregation, expected] of [
		["sum", 6],
		["mean", 3],
		["median", 3],
	] as const) {
		const result = chart(input, { x: 3, y: 9, aggregation, filters: [{ column: 3, op: "eq", value: "A" }] });
		assert.equal(result.filteredRows, 3);
		assert.equal(result.excludedRows, 1);
		assert.equal(result.marks.length, 1);
		near(result.marks[0].value, expected);
		assert.deepEqual(result.marks[0].rowIds, [3, 4]);
		assert.deepEqual(
			result.table.columns.map((column) => column.index),
			[3, 9],
		);
		assert.deepEqual(
			result.table.rows.map((row) => row.rowId),
			[3, 4, 5],
		);
	}
	const none = chart(input, { x: 3, y: 9, aggregation: "none", filters: [{ column: 3, op: "eq", value: "A" }] });
	assert.deepEqual(
		none.marks.map((mark) => mark.value),
		[2, 4],
	);
	assert.deepEqual(
		none.marks.map((mark) => mark.rowIds),
		[[3], [4]],
	);
	hasWarning(none, /overplot/);
});

test("all filter operators use strict numeric or exact text semantics without NULL coercion", () => {
	const input = sample([
		[null],
		[""],
		["1"],
		["2"],
		["02"],
		[" 2"],
		["2\n"],
		["0x2"],
		["9007199254740993"],
		["1e-999"],
		["Alpha"],
		["alpha"],
	]);
	const cases: [ChartFilter["op"], string, number[]][] = [
		["is-null", "", [0]],
		["not-null", "", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
		["eq", "2", [3]],
		["neq", "2", [1, 2, 4, 5, 6, 7, 8, 9, 10, 11]],
		["contains", "Al", [10]],
		["gt", "1", [3, 4]],
		["gte", "2", [3, 4]],
		["lt", "2", [2]],
		["lte", "1", [2]],
	];
	for (const [op, value, expected] of cases) {
		const result = chart(input, { filters: [{ column: 0, op, value }] });
		assert.deepEqual(
			result.table.rows.map((row) => row.rowId),
			expected,
			op,
		);
		assert.equal(result.filteredRows, expected.length);
		assert.equal(result.marks[0]?.value ?? 0, expected.length);
	}
	const combined = chart(input, {
		filters: [
			{ column: 0, op: "gte", value: "1" },
			{ column: 0, op: "lt", value: "2" },
		],
	});
	assert.deepEqual(combined.marks[0].rowIds, [2]);
	assert.match(combined.labels.filters, /AND/);
});

test("category guards retain no partial other group and accurately disclose dropped rows and marks", () => {
	const input = sample(Array.from({ length: 4096 }, (_, index) => [`category-${index % 40}`]));
	const result = chart(input, { x: 0, categoryLimit: 3, sort: "value-descending" });
	assert.equal(result.marks.length, 3);
	assert.equal(result.omittedMarks, 37);
	assert.equal(result.excludedRows, 4096 - 103 * 3);
	assert.ok(result.marks.every((mark) => mark.value === 103 && mark.rowIds.length === 103));
	assert.equal(result.table.rows.length, 100);
	hasWarning(result, /first 3 distinct categories/);
	hasWarning(result, /not merged or ranked globally/);
	const long = chart(sample([[`${"x".repeat(200)}a`], [`${"x".repeat(200)}b`]]), { x: 0 });
	assert.equal(new Set(long.marks.map((mark) => mark.x)).size, 2);
	assert.ok(long.marks.every((mark) => String(mark.x).length < 180));
	hasWarning(long, /shortened/);
});

test("color and facet limits exclude extra categories without losing accepted memberships", () => {
	const colors = chart(sample(Array.from({ length: 12 }, (_, index) => ["group", String(index)])), { x: 0, color: 1 });
	assert.equal(colors.marks.length, 10);
	assert.equal(colors.excludedRows, 2);
	assert.equal(colors.omittedMarks, 2);
	hasWarning(colors, /Color is limited to the first 10/);
	const facets = chart(sample(Array.from({ length: 6 }, (_, index) => ["group", String(index)])), { x: 0, facet: 1 });
	assert.equal(facets.marks.length, 4);
	assert.equal(facets.excludedRows, 2);
	assert.equal(facets.omittedMarks, 2);
	hasWarning(facets, /Facet is limited to the first 4/);
});

test("line charts distinguish numeric, strict ISO and categorical ordering and sort deterministically", () => {
	const numeric = chart(
		sample(
			[
				["10", "1"],
				["2", "4"],
				["2", "6"],
			],
			["number", "number"],
		),
		{ type: "line", x: 0, y: 1, aggregation: "mean" },
	);
	assert.deepEqual(
		numeric.marks.map((mark) => [mark.x, mark.value]),
		[
			[2, 5],
			[10, 1],
		],
	);
	assert.match(numeric.labels.x, /numeric order/);
	const dates = chart(
		sample(
			[
				["2024-03-01", "2"],
				["2024-02-29", "1"],
				["2023-02-29", "3"],
				["2024-01-01T12:00:00", "4"],
				["2024-01-01T00:00:00+14:30", "5"],
			],
			["datetime", "number"],
		),
		{ type: "line", x: 0, y: 1, aggregation: "sum" },
	);
	assert.deepEqual(
		dates.marks.map((mark) => mark.x),
		["2024-02-29T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
	);
	assert.equal(dates.excludedRows, 3);
	assert.match(dates.labels.x, /ISO date order/);
	hasWarning(dates, /timezone-ambiguous/);
	const equivalent = chart(
		sample(
			[
				["2024-01-01T00:00:00Z", "1"],
				["2024-01-01T01:00:00+01:00", "3"],
			],
			["datetime", "number"],
		),
		{ type: "line", x: 0, y: 1, aggregation: "sum" },
	);
	assert.equal(equivalent.marks.length, 1);
	assert.equal(equivalent.marks[0].value, 4);
	const categories = chart(
		sample(
			[
				["b", "1"],
				["a", "3"],
			],
			["text", "number"],
		),
		{ type: "line", x: 0, y: 1, aggregation: "sum", sort: "descending" },
	);
	assert.deepEqual(
		categories.marks.map((mark) => mark.x),
		['"b"', '"a"'],
	);
	assert.match(categories.labels.x, /categorical order/);
	hasWarning(categories, /bar chart is often more appropriate/);
	const byValue = chart(
		sample(
			[
				["b", "1"],
				["a", "3"],
			],
			["text", "number"],
		),
		{ type: "line", x: 0, y: 1, aggregation: "sum", sort: "value-descending" },
	);
	assert.deepEqual(
		byValue.marks.map((mark) => mark.value),
		[3, 1],
	);
	hasWarning(byValue, /not X progression/);
});

test("scatter honors size and position semantics, numeric exclusion and the 1000-point limit", () => {
	const rows = Array.from({ length: 1005 }, () => ["1", "2", "4"]);
	rows.push(["2", "3", "-1"], ["3", "4", "NaN"], ["9007199254740993", "1", "2"]);
	const result = chart(sample(rows, ["number", "number", "number"]), {
		type: "scatter",
		x: 0,
		y: 1,
		size: 2,
		aggregation: "none",
	});
	assert.equal(result.marks.length, 1000);
	assert.equal(result.omittedMarks, 5);
	assert.equal(result.excludedRows, 8);
	assert.deepEqual([result.marks[0].x, result.marks[0].y, result.marks[0].size], [1, 2, 4]);
	assert.equal(new Set(result.marks.flatMap((mark) => mark.rowIds)).size, 1000);
	hasWarning(result, /Overplotting/);
	hasWarning(result, /negative symbol sizes/);
});

test("heatmaps aggregate XY pairs and numeric size measures independently inside facets", () => {
	const input = sample(
		[
			["a", "b", "1", "f"],
			["a", "b", "3", "f"],
			["a", "b", "5", "g"],
			["a", null, "2", "f"],
			["a", "", "4", "f"],
		],
		["text", "text", "number", "text"],
	);
	const mean = chart(input, { type: "heatmap", x: 0, y: 1, size: 2, facet: 3, aggregation: "mean" });
	assert.equal(mean.marks.length, 4);
	const group = mean.marks.find((mark) => mark.y === '"b"' && mark.facet === '"f"');
	assert.equal(group?.value, 2);
	assert.deepEqual(group?.rowIds, [0, 1]);
	assert.equal(mean.marks.find((mark) => mark.facet === '"g"')?.value, 5);
	const count = chart(input, { type: "heatmap", x: 0, y: 1 });
	assert.equal(count.marks.find((mark) => mark.y === '"b"')?.value, 3);
	assert.ok(count.marks.some((mark) => mark.y === "NULL"));
	assert.ok(count.marks.some((mark) => mark.y === '""'));
});

test("correlations are pairwise complete, finite, signed and undefined for constants", () => {
	const input = sample(
		[
			["1", "2", "7"],
			["2", "4", "7"],
			["3", null, "7"],
			[null, "8", "7"],
			["4", "8", "7"],
		],
		["number", "number", "number"],
	);
	const result = chart(input, { type: "correlation", aggregation: "none" });
	assert.equal(result.marks.length, 9);
	const pair = result.marks.find((mark) => mark.x === "field0 [0]" && mark.y === "field1 [1]")!;
	near(pair.value, 1);
	assert.deepEqual(pair.rowIds, [0, 1, 4]);
	assert.equal(result.marks.find((mark) => mark.x === "field2 [2]" && mark.y === "field2 [2]")?.value, null);
	hasWarning(result, /Undefined correlations/);
	const inverse = chart(
		sample(
			[
				["1e-20", "3"],
				["2e-20", "2"],
				["3e-20", "1"],
			],
			["number", "number"],
		),
		{ type: "correlation", aggregation: "none" },
	);
	near(inverse.marks[1].value, -1);
});

test("correlation dimensions and linked IDs are bounded and disclose limited highlighting", () => {
	const input = sample(
		Array.from({ length: 4096 }, (_, row) => Array.from({ length: 13 }, (_, column) => String(row + column))),
		Array.from({ length: 13 }, () => "number" as const),
	);
	const result = chart(input, { type: "correlation", aggregation: "none" });
	assert.equal(result.marks.length, 144);
	assert.ok(result.marks.reduce((sum, mark) => sum + mark.rowIds.length, 0) <= 32768);
	assert.equal(result.excludedRows, 0);
	hasWarning(result, /first 12/);
	hasWarning(result, /Linked selection is limited/);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < CHART_RESULT_BYTES);
});

test("missingness bounds cells and source columns while preserving NULL versus empty", () => {
	const input = sample(
		Array.from({ length: 200 }, () => Array.from({ length: 25 }, (_, column) => (column === 0 ? null : ""))),
		Array.from({ length: 25 }, () => "text" as const),
	);
	const result = chart(input, { type: "missingness", aggregation: "none" });
	assert.equal(result.marks.length, 24 * 170);
	assert.ok(result.marks.length <= CHART_MAX_MARKS);
	assert.equal(result.omittedMarks, 24 * 30);
	assert.equal(result.excludedRows, 30);
	assert.equal(result.marks[0].value, 1);
	assert.equal(result.marks[1].value, 0);
	assert.deepEqual(result.marks[0].rowIds, [0]);
	assert.equal(new Set(result.marks.map((mark) => mark.x)).size, 24);
	const projected = chart(sample([[null, "", "keep"]], ["text", "text", "text"], [2, 9, 42]), {
		type: "missingness",
		aggregation: "none",
		filters: [{ column: 42, op: "eq", value: "keep" }],
	});
	assert.equal(projected.marks.length, 2);
	assert.deepEqual(
		projected.table.columns.map((column) => column.index),
		[2, 9, 42],
	);
});

test("header-only and all-null numeric charts are empty; model results are explicitly untrained", () => {
	const empty = sample([], ["number", "number"]);
	const nulls = sample(
		[
			[null, null],
			[null, null],
		],
		["number", "number"],
	);
	for (const input of [empty, nulls]) {
		for (const changes of [
			{ type: "histogram", x: 0, aggregation: "count" },
			{ type: "box", y: 0, aggregation: "none" },
			{ type: "scatter", x: 0, y: 1, aggregation: "none" },
			{ type: "correlation", aggregation: "none" },
		] as Partial<ChartSpec>[]) {
			const result = chart(input, changes);
			assert.deepEqual(result.marks, []);
			hasWarning(result, /No plottable values/);
		}
	}
	const placeholder = chart(nulls, { type: "model-result", aggregation: "none" });
	assert.deepEqual(placeholder.marks, []);
	hasWarning(placeholder, /Untrained model-result placeholder/);
	assert.match(placeholder.labels.aggregation, /no model has been trained/);
});

test("safe outputs preserve input, exact filter labels, table byte bounds and misleading-axis warnings", () => {
	const operand = "a".repeat(200);
	const input = sample(
		[
			[operand, "1"],
			["b".repeat(600_000), "2"],
		],
		["text", "number"],
		undefined,
		2,
	);
	const before = JSON.stringify(input);
	const result = chart(input, { y: 1, aggregation: "sum", zeroBaseline: false, yMin: 1 });
	assert.equal(JSON.stringify(input), before);
	assert.equal(result.table.rows.length, 1);
	assert.equal(result.marks[0].value, 3);
	assert.deepEqual(result.marks[0].rowIds, [0, 2]);
	hasWarning(result, /nonzero bar baseline/);
	hasWarning(result, /axis minima/);
	hasWarning(result, /dual axes/);
	hasWarning(result, /512 KiB/);
	const filter = chart(input, { filters: [{ column: 0, op: "eq", value: operand }] });
	assert.ok(filter.labels.filters.includes(JSON.stringify(operand)));
	const spec = defaultChartSpec("fixture");
	assert.throws(() => computeChart({ ...spec, x: 999 }, input, "hash", "time"), {
		message: "Chart fields are unavailable.",
	});
	assert.throws(
		() =>
			computeChart(
				spec,
				{ ...input, rows: Array.from({ length: 4097 }, (_, rowId) => ({ rowId, values: ["sensitive", "1"] })) },
				"hash",
				"time",
			),
		{ message: "Invalid chart configuration." },
	);
});
