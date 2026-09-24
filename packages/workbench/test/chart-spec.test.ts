import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_TYPES, type ChartMark, type ChartResult, type ChartSpec } from "../src/chart-contracts.ts";
import { defaultChartSpec, generateChartPython, parseChartSpec, recommendCharts } from "../src/chart-spec.ts";
import type { DatasetColumn } from "../src/contracts.ts";
import { computeDatasetProfile } from "../src/dataset-profiler.ts";

const version = "fixture-version";
const schema: DatasetColumn[] = [
	{ index: 0, name: "value", sourceType: "DOUBLE", basicType: "number" },
	{ index: 1, name: "score", sourceType: "DOUBLE", basicType: "number" },
	{ index: 2, name: "category", sourceType: "VARCHAR", basicType: "text" },
	{ index: 3, name: "segment", sourceType: "VARCHAR", basicType: "text" },
	{ index: 4, name: "day", sourceType: "TIMESTAMP", basicType: "datetime" },
	{ index: 5, name: "enabled", sourceType: "BOOLEAN", basicType: "boolean" },
	{ index: 6, name: "nested", sourceType: "STRUCT", basicType: "nested" },
	{ index: 7, name: "bytes", sourceType: "BLOB", basicType: "binary" },
];

function specFor(type: ChartSpec["type"]): ChartSpec {
	const spec = defaultChartSpec(version);
	spec.type = type;
	switch (type) {
		case "histogram":
			spec.x = 0;
			break;
		case "box":
			Object.assign(spec, { x: 2, y: 0, aggregation: "none" });
			break;
		case "bar":
			spec.x = 2;
			break;
		case "line":
			Object.assign(spec, { x: 4, y: 0, aggregation: "mean" });
			break;
		case "scatter":
			Object.assign(spec, { x: 0, y: 1, size: 0, aggregation: "none" });
			break;
		case "heatmap":
			Object.assign(spec, { x: 2, y: 3 });
			break;
		default:
			spec.aggregation = "none";
	}
	return spec;
}

function resultFor(type: ChartSpec["type"], overrides: Partial<ChartMark> = {}): ChartResult {
	return {
		spec: specFor(type),
		datasetVersionHash: "a".repeat(64),
		generatedAt: "2026-09-24T00:00:00.000Z",
		populationRows: 100,
		sampleSize: 10,
		stride: 10,
		byteLimited: true,
		sampled: true,
		filteredRows: 3,
		excludedRows: 1,
		omittedMarks: 2,
		marks:
			type === "model-result"
				? []
				: [
						{
							x:
								type === "line"
									? "2026-09-24T00:00:00.000Z"
									: type === "scatter" || type === "histogram"
										? 1
										: "category",
							y: type === "heatmap" || type === "correlation" ? "segment" : 2,
							value: 2,
							color: null,
							size: null,
							facet: null,
							low: 1,
							high: 3,
							q1: 1.5,
							median: 2,
							q3: 2.5,
							rowIds: [10, 40],
							...overrides,
						},
					],
		table: { columns: schema, rows: [{ rowId: 10, values: ["private table-only source"] }] },
		warnings: ["Sampled observations, not population estimates"],
		labels: {
			x: "X",
			y: "Y",
			color: "Color",
			size: "Size",
			facet: "Facet",
			aggregation: "mean of filtered sample",
			filters: "one filter",
			missing: "excluded invalid values",
		},
	};
}

function frozenFromPython(code: string): Record<string, unknown> {
	const encoded = /^chart = json\.loads\((.*)\)$/mu.exec(code);
	assert.ok(encoded, "The complete frozen observation is a data literal, not generated Python expressions");
	return JSON.parse(JSON.parse(encoded[1])) as Record<string, unknown>;
}

test("default charts are safe count bars with no implicit fields and preserve serialization", () => {
	const first = defaultChartSpec(version);
	assert.equal(first.type, "bar");
	assert.equal(first.aggregation, "count");
	assert.equal(first.zeroBaseline, true);
	assert.equal(first.xMin, null);
	assert.equal(first.yMin, null);
	for (const key of ["x", "y", "color", "size", "facet"] as const) assert.equal(first[key], null);
	assert.deepEqual(parseChartSpec(JSON.parse(JSON.stringify(first)), schema, version), first);
	first.filters.push({ column: 2, op: "eq", value: "A" });
	assert.deepEqual(defaultChartSpec(version).filters, []);
});

test("all chart types roundtrip supported controls without changing the caller", () => {
	for (const type of CHART_TYPES) {
		const spec = specFor(type);
		const parsed = parseChartSpec(JSON.parse(JSON.stringify(spec)), schema, version);
		assert.deepEqual(parsed, spec, type);
		assert.notEqual(parsed, spec);
	}
	const custom = {
		...specFor("scatter"),
		color: 2,
		facet: 3,
		xMin: -2,
		yMin: 0,
		zeroBaseline: false,
		filters: [{ column: 0, op: "gte", value: "-1.25e2" }],
	};
	const parsed = parseChartSpec(custom, schema, version);
	assert.deepEqual(parsed, custom);
	assert.notEqual(parsed.filters, custom.filters);
	assert.notEqual(parsed.filters[0], custom.filters[0]);
	for (const aggregation of ["sum", "mean", "median"] as const) {
		const heatmap = { ...specFor("heatmap"), aggregation, size: 0, facet: 3 };
		assert.deepEqual(parseChartSpec(heatmap, schema, version), heatmap);
	}
});

test("unknown options, incomplete specs and unsupported versions fail without echoing source text", () => {
	const base = defaultChartSpec(version);
	for (const value of [
		null,
		[],
		"x",
		{},
		{ ...base, version: 2 },
		{ ...base, datasetVersionId: "another-version" },
		{ ...base, type: "script" },
		{ ...base, y2: 0 },
		{ ...base, dualAxes: true },
		{ ...base, dangerousPrivateColumnName: "private-source-value" },
		{ ...base, [Symbol("hidden")]: true },
	]) {
		assert.throws(
			() => parseChartSpec(value, schema, version),
			(error: unknown) =>
				error instanceof Error &&
				!error.message.includes("private-source-value") &&
				!error.message.includes("dangerousPrivateColumnName"),
		);
	}
	const incomplete: Partial<ChartSpec> = { ...base };
	delete incomplete.categoryLimit;
	assert.throws(() => parseChartSpec(incomplete, schema, version));
	assert.throws(() => parseChartSpec(Object.assign(Object.create({ inherited: true }), base), schema, version));
});

test("all field indexes use schema identity and reject missing, fractional and nonscalar fields", () => {
	for (const key of ["x", "y", "color", "size", "facet"] as const) {
		for (const index of [-1, 1.5, 100, "0", undefined, NaN, Infinity])
			assert.throws(() => parseChartSpec({ ...specFor("scatter"), [key]: index }, schema, version));
		for (const index of [6, 7])
			assert.throws(() => parseChartSpec({ ...specFor("scatter"), [key]: index }, schema, version));
	}
	assert.throws(() => parseChartSpec({ ...specFor("scatter"), x: 5 }, schema, version));
	const sparseSchema = [{ ...schema[0], index: 10 }];
	assert.equal(parseChartSpec({ ...defaultChartSpec(version), x: 10 }, sparseSchema, version).x, 10);
	assert.throws(() => parseChartSpec({ ...defaultChartSpec(version), x: 0 }, sparseSchema, version));
});

test("bounds and exact enums reject nonfinite/coerced controls while permitting boundaries", () => {
	for (const bins of [5, 100])
		assert.equal(parseChartSpec({ ...specFor("histogram"), bins }, schema, version).bins, bins);
	for (const categoryLimit of [1, 30])
		assert.equal(
			parseChartSpec({ ...defaultChartSpec(version), categoryLimit }, schema, version).categoryLimit,
			categoryLimit,
		);
	for (const [key, values] of Object.entries({
		bins: [4, 101, 5.5, "20"],
		categoryLimit: [0, 31, 1.5, "2"],
		xMin: [NaN, Infinity, -Infinity, "0"],
		yMin: [NaN, Infinity, "0"],
		zeroBaseline: [0, 1, "true"],
		aggregation: ["average", "COUNT", null],
		sort: ["random", "asc", null],
	})) {
		for (const value of values)
			assert.throws(() => parseChartSpec({ ...specFor("scatter"), [key]: value }, schema, version), key);
	}
});

test("ignored encodings and incompatible aggregations are rejected explicitly", () => {
	const invalid: ChartSpec[] = [
		{ ...specFor("histogram"), y: 1 },
		{ ...specFor("histogram"), aggregation: "mean" },
		{ ...specFor("box"), y: null },
		{ ...specFor("box"), aggregation: "count" },
		{ ...specFor("bar"), y: 1 },
		{ ...specFor("bar"), aggregation: "sum" },
		{ ...specFor("bar"), xMin: 0 },
		{ ...specFor("line"), x: null },
		{ ...specFor("line"), size: 0 },
		{ ...specFor("scatter"), aggregation: "mean" },
		{ ...specFor("scatter"), sort: "descending" },
		{ ...specFor("heatmap"), color: 0 },
		{ ...specFor("heatmap"), size: 0 },
		{ ...specFor("heatmap"), aggregation: "mean" },
		{ ...specFor("heatmap"), zeroBaseline: false },
	];
	for (const type of ["correlation", "missingness", "model-result"] as const) {
		for (const key of ["x", "y", "color", "size", "facet"] as const) invalid.push({ ...specFor(type), [key]: 0 });
		invalid.push(
			{ ...specFor(type), aggregation: "count" },
			{ ...specFor(type), xMin: 0 },
			{ ...specFor(type), yMin: 0 },
		);
	}
	for (const spec of invalid) assert.throws(() => parseChartSpec(spec, schema, version), spec.type);
	assert.equal(
		parseChartSpec({ ...specFor("line"), x: 2, sort: "value-descending" }, schema, version).sort,
		"value-descending",
	);
});

test("filters remain bounded literal scalar data with strict ordered comparisons", () => {
	const parse = (filters: unknown) => parseChartSpec({ ...defaultChartSpec(version), filters }, schema, version);
	const literal = "'); __import__('os').system('private'); #\n\u2028汉字\\u0000";
	assert.equal(parse([{ column: 2, op: "contains", value: literal }]).filters[0].value, literal);
	assert.equal(
		parse(Array.from({ length: 8 }, () => ({ column: 2, op: "eq", value: "x".repeat(512) }))).filters.length,
		8,
	);
	assert.deepEqual(parse([{ column: 7, op: "is-null", value: "" }]).filters, [
		{ column: 7, op: "is-null", value: "" },
	]);
	for (const filters of [
		null,
		{},
		Array.from({ length: 9 }, () => ({ column: 2, op: "eq", value: "A" })),
		[{ column: 2, op: "eq", value: "x".repeat(513) }],
		[{ column: 100, op: "eq", value: "" }],
		[{ column: 2, op: "eq", value: 2 }],
		[{ column: 2, op: "eq", value: null }],
		[{ column: 2, op: "sql", value: "" }],
		[{ column: 2, op: "eq", value: "", sql: "ignored" }],
		[{ column: 2, op: "is-null", value: "ignored" }],
		[{ column: 7, op: "eq", value: "" }],
	])
		assert.throws(() => parse(filters));
	for (const value of ["NaN", "Infinity", "0x10", " 1", "1\n", "1e-999", "9007199254740993", "1e309", ""])
		assert.throws(() => parse([{ column: 0, op: "gt", value }]));
	for (const value of ["0", "-0", "+1.25e2", "-10.5", "1e-20"])
		assert.equal(parse([{ column: 0, op: "gte", value }]).filters[0].value, value);
});

function profileFixture(population = 6) {
	const rows = Array.from({ length: 6 }, (_, index) => [
		String(index + 1),
		String((index + 1) ** 2),
		index % 2 ? "A" : "B",
		index % 3 ? "east" : "west",
		`2026-09-${String(index + 1).padStart(2, "0")}`,
		index % 2 ? "true" : "false",
		"{}",
		null,
	]);
	return computeDatasetProfile(
		{
			datasetVersionId: version,
			datasetVersionHash: "a".repeat(64),
			rowCount: population,
			sourceBytes: 100,
			storageBytes: 100,
			schema,
		},
		rows,
		{
			method: population > rows.length ? "systematic" : "full",
			populationRows: population,
			sampleSize: rows.length,
			stride: Math.ceil(population / rows.length),
			byteLimited: false,
			approximate: population > rows.length,
		},
		"2026-09-24T00:00:00.000Z",
	);
}

test("profile semantics recommend every applicable primary chart with valid fields", () => {
	const profile = profileFixture();
	const recommendations = recommendCharts(profile);
	assert.deepEqual(new Set(recommendations.map((item) => item.type)), new Set(CHART_TYPES));
	assert.deepEqual(recommendCharts(profile), recommendations);
	assert.equal(recommendations.find((item) => item.type === "histogram")?.x, 0);
	assert.equal(recommendations.find((item) => item.type === "bar")?.x, 2);
	assert.equal(recommendations.find((item) => item.type === "line")?.x, 4);
	for (const recommendation of recommendations) {
		const spec = { ...specFor(recommendation.type), x: recommendation.x, y: recommendation.y };
		assert.deepEqual(parseChartSpec(spec, schema, version), spec);
		assert.match(recommendation.reason, /current profile|Untrained/);
	}
});

test("recommendations explain approximation and avoid identifiers, high cardinality and empty numeric suggestions", () => {
	const profile = profileFixture(600);
	for (const recommendation of recommendCharts(profile))
		assert.match(recommendation.reason, /Approximate heuristic.*6 sampled rows of 600.*not a population estimate/);
	profile.columns[0].name = "customer_id";
	profile.columns[0].semanticTypes.push({ type: "identifier", confidence: 1, reason: "Unique key" });
	profile.columns[2].distinctCount = 100;
	const recommendations = recommendCharts(profile);
	assert.equal(recommendations.find((item) => item.type === "histogram")?.x, 1);
	assert.ok(!recommendations.some((item) => item.x === 0 || item.y === 0 || (item.type === "bar" && item.x === 2)));
	assert.ok(!recommendations.some((item) => item.type === "scatter" || item.type === "correlation"));
	const empty = { ...profile, columns: [], columnCount: 0 };
	assert.deepEqual(
		recommendCharts(empty).map((item) => item.type),
		["model-result"],
	);
});

test("Python freezes the full plotted observation and provenance for every supported chart kind", () => {
	for (const type of CHART_TYPES) {
		const result = resultFor(type);
		const code = generateChartPython(result);
		const frozen = frozenFromPython(code);
		for (const key of [
			"spec",
			"marks",
			"labels",
			"warnings",
			"datasetVersionHash",
			"generatedAt",
			"populationRows",
			"sampleSize",
			"stride",
			"byteLimited",
			"sampled",
			"filteredRows",
			"excludedRows",
			"omittedMarks",
		] as const)
			assert.deepEqual(frozen[key], result[key], `${type}: ${key}`);
		assert.ok(!Object.hasOwn(frozen, "table"), "Reproduction does not need extra raw table values");
		assert.ok(!code.includes("private table-only source"));
		assert.match(code, /No population extrapolation occurs/);
		assert.match(code, /NOT a reimplementation over source data/);
		assert.match(code, /plt\.savefig\("chart\.png"/);
	}
});

test("Python serialization safely quotes Unicode, controls, quotes and code-shaped data", () => {
	const attack =
		"'); __import__('os').system('do-not-execute'); #\n\r\t\u0000\u001b\u2028\u2029é汉字😀\ud800\\n\\u2028\"'''</script>$\\frac{x}{y}$";
	const result = resultFor("bar", { x: attack, color: attack, facet: attack });
	result.labels.x = attack;
	result.warnings.push(attack);
	result.spec.filters = [{ column: 2, op: "contains", value: attack }];
	const code = generateChartPython(result);
	const frozen = frozenFromPython(code);
	assert.deepEqual(frozen.marks, result.marks);
	assert.deepEqual(frozen.spec, result.spec);
	assert.deepEqual(frozen.labels, result.labels);
	assert.deepEqual(frozen.warnings, result.warnings);
	const payloadLine = code.split("\n").find((line) => line.startsWith("chart = json.loads("));
	assert.ok(payloadLine);
	assert.doesNotMatch(payloadLine, /[^\x20-\x7e]/u, "Embedded source data use ASCII escapes only");
	assert.equal(code.split("\n").filter((line) => line.includes("do-not-execute")).length, 1);
	assert.match(code, /text\.parse_math.*False/);
	assert.ok(code.indexOf('raise RuntimeError("Untrained') < code.indexOf("import matplotlib"));
});

test("Python renders chart-specific frozen summaries, grouped color/facets and size without recomputing data", () => {
	const code = generateChartPython(resultFor("scatter"));
	for (const branch of [
		"histogram",
		"box",
		"bar",
		"line",
		"scatter",
		"heatmap",
		"correlation",
		"missingness",
		"model-result",
	])
		assert.ok(code.includes(`"${branch}"`), branch);
	assert.match(code, /axis\.bxp\(\[summary\]/);
	assert.match(code, /mark\["high"\] - mark\["low"\]/);
	assert.match(code, /axis\.scatter/);
	assert.match(code, /axis\.plot/);
	assert.match(code, /Rectangle\(/);
	assert.match(code, /for axis, facet in zip\(axes, facets\)/);
	assert.match(code, /color_index\[mark\["color"\]\]/);
	assert.match(code, /math\.sqrt\(max\(0, mark\["size"\]\)/);
	assert.doesNotMatch(code, /import pandas|import numpy|read_csv|\.hist\(|\.boxplot\(|eval\(|exec\(/);
});
