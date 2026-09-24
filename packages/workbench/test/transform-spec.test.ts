import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetColumn } from "../src/contracts.ts";
import type { TransformExpression, TransformOperation } from "../src/transform-contracts.ts";
import { parseTransformSpec } from "../src/transform-spec.ts";

const schema: DatasetColumn[] = [
	{ index: 0, name: "number", sourceType: "DOUBLE", basicType: "number" },
	{ index: 1, name: "text", sourceType: "VARCHAR", basicType: "text" },
	{ index: 2, name: "date", sourceType: "DATE", basicType: "datetime" },
	{ index: 3, name: "nested", sourceType: "STRUCT", basicType: "nested" },
];
const spec = (operation: TransformOperation) => ({ version: 1 as const, datasetVersionId: "v1", operation });
const operations: TransformOperation[] = [
	{ kind: "rename", column: 0, name: "renamed" },
	{ kind: "cast", column: 1, type: "number", invalid: "null" },
	{ kind: "drop", columns: [0, 2] },
	{ kind: "filter", column: 1, operator: "eq", comparison: "text", value: "' OR 1=1 --" },
	{ kind: "missing", columns: [0, 1], method: "constant", missing: "both", value: "" },
	{ kind: "deduplicate", columns: [0, 3] },
	{ kind: "map", column: 1, entries: [{ from: "", to: null }], unmatched: "keep" },
	{ kind: "datetime", column: 2, component: "weekday", name: "weekday" },
	{ kind: "scale", column: 0, method: "standard", name: "scaled" },
	{ kind: "encode", column: 1, method: "one-hot", categories: ["b", "a"], name: "encoded" },
	{
		kind: "derive",
		name: "derived",
		expression: {
			kind: "binary",
			operator: "add",
			left: { kind: "column", column: 0 },
			right: { kind: "literal", value: 1 },
		},
	},
];

test("every transformation operation roundtrips without mutable caller nodes", () => {
	for (const operation of operations) {
		const original = spec(operation);
		const result = parseTransformSpec(original, schema, "v1");
		assert.deepEqual(result, original);
		assert.notEqual(result, original);
		assert.notEqual(result.operation, operation);
	}
});

test("unknown fields, executable expressions and invalid controls fail closed", () => {
	const base = spec(operations[0]);
	for (const value of [
		null,
		[],
		{},
		{ ...base, version: 2 },
		{ ...base, datasetVersionId: "v2" },
		{ ...base, sql: "DROP TABLE data" },
		{ ...base, [Symbol("hidden")]: true },
		{ ...base, operation: { ...operations[0], code: "process.exit()" } },
		{ ...base, operation: { kind: "derive", name: "x", expression: "c0+1" } },
		{
			...base,
			operation: { kind: "derive", name: "x", expression: { kind: "call", function: "read_csv", args: [] } },
		},
	])
		assert.throws(() => parseTransformSpec(value, schema, "v1"));
	for (const operation of [
		{ kind: "rename", column: 0, name: "text" },
		{ kind: "rename", column: 0, name: " " },
		{ kind: "rename", column: 0, name: "a\0b" },
		{ kind: "drop", columns: [0, 1, 2, 3] },
		{ kind: "drop", columns: [0, 0] },
		{ kind: "drop", columns: [] },
		{ kind: "cast", column: 4, type: "text", invalid: "null" },
		{ kind: "cast", column: 3, type: "text", invalid: "null" },
		{ kind: "filter", column: 0, operator: "eq", comparison: "number", value: "Infinity" },
		{ kind: "filter", column: 0, operator: "contains", comparison: "number", value: "1" },
		{ kind: "filter", column: 0, operator: "is-null", comparison: "text", value: "" },
		{ kind: "missing", columns: [0], method: "mean", missing: "null", value: "1" },
		{
			kind: "map",
			column: 1,
			entries: [
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
			],
			unmatched: "keep",
		},
		{ kind: "encode", column: 1, method: "ordinal", categories: ["a", "a"], name: "code" },
	])
		assert.throws(() => parseTransformSpec({ ...base, operation }, schema, "v1"));
});

test("expression limits reject cycles, depth, node count, arity and unsafe numbers", () => {
	const parse = (expression: unknown) =>
		parseTransformSpec(
			{ ...spec(operations[0]), operation: { kind: "derive", name: "x", expression } },
			schema,
			"v1",
		);
	for (const number of [Infinity, NaN, 9007199254740992])
		assert.throws(() => parse({ kind: "literal", value: number }));
	for (const fn of ["abs", "round", "lower", "upper", "trim", "length", "coalesce"])
		assert.throws(() => parse({ kind: "call", function: fn, args: [] }));
	let deep: TransformExpression = { kind: "literal", value: 1 };
	for (let index = 0; index < 18; index++) deep = { kind: "call", function: "abs", args: [deep] };
	assert.throws(() => parse(deep), /limit/);
	let wide: TransformExpression = { kind: "literal", value: 1 };
	for (let index = 0; index < 8; index++) wide = { kind: "binary", operator: "add", left: wide, right: wide };
	assert.throws(() => parse(wide), /limit/);
	const cyclic: { kind: "call"; function: "abs"; args: unknown[] } = { kind: "call", function: "abs", args: [] };
	cyclic.args.push(cyclic);
	assert.throws(() => parse(cyclic), /limit/);
	assert.throws(() => parse({ kind: "literal", value: "x".repeat(4097) }), /bounded/);
});

test("size, generated width and disclosed noncontiguous indexes are enforced", () => {
	const wide = Array.from(
		{ length: 512 },
		(_, index): DatasetColumn => ({ index, name: `field_${index}`, sourceType: "VARCHAR", basicType: "text" }),
	);
	assert.throws(
		() =>
			parseTransformSpec(
				spec({ kind: "encode", column: 0, method: "one-hot", categories: ["a"], name: "new" }),
				wide,
				"v1",
			),
		/512/,
	);
	assert.throws(
		() =>
			parseTransformSpec(
				spec({
					kind: "encode",
					column: 0,
					method: "ordinal",
					categories: Array.from({ length: 129 }, (_, index) => String(index)),
					name: "new",
				}),
				schema,
				"v1",
			),
		/128/,
	);
	assert.throws(
		() =>
			parseTransformSpec(
				spec({
					kind: "map",
					column: 1,
					entries: Array.from({ length: 10 }, (_, index) => ({ from: String(index), to: "x".repeat(4000) })),
					unmatched: "keep",
				}),
				schema,
				"v1",
			),
		/size/,
	);
	assert.equal(
		parseTransformSpec(spec({ kind: "datetime", column: 2, component: "year", name: "year" }), [schema[2]], "v1")
			.operation.kind,
		"datetime",
	);
	assert.throws(
		() =>
			parseTransformSpec(spec({ kind: "datetime", column: 0, component: "year", name: "year" }), [schema[2]], "v1"),
		/does not exist/,
	);
});
