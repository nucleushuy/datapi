import { MAX_COLUMNS, type DatasetColumn } from "./contracts.ts";
import { finiteNumber } from "./profiler.ts";
import { TRANSFORM_SPEC_BYTES, TRANSFORM_VERSION, type TransformExpression, type TransformOperation, type TransformSpec } from "./transform-contracts.ts";

const encoder = new TextEncoder();
function requireSpec(condition: unknown, message = "Transformation specification contains missing or unsupported options."): asserts condition {
	if (!condition) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function fields(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
	requireSpec(object(value) && Reflect.ownKeys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)));
	for (const key of expected) requireSpec(Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
	requireSpec(typeof value === "string" && values.includes(value as T));
	return value as T;
}
function string(value: unknown, limit = 4096): string {
	requireSpec(typeof value === "string" && value.length <= limit && !value.includes("\0"), "Transformation values must be bounded strings without NUL characters.");
	return value;
}
function nullable(value: unknown): string | null {
	return value === null ? null : string(value);
}

/** Pure validation shared by browser, persistence and isolated worker. */
export function parseTransformSpec(value: unknown, schema: DatasetColumn[], versionId: string): TransformSpec {
	fields(value, ["version", "datasetVersionId", "operation"]);
	requireSpec(value.version === TRANSFORM_VERSION, "Unsupported transformation specification version.");
	requireSpec(value.datasetVersionId === versionId && /^[a-zA-Z0-9_-]{1,80}$/u.test(versionId), "Transformation specification does not match the current dataset version.");
	requireSpec(schema.length >= 1 && schema.length <= MAX_COLUMNS && schema.every((column, index) => column.index === index), "Transformation requires a valid input schema.");
	const column = (index: unknown): number => {
		requireSpec(typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < schema.length, "Transformation field does not exist in the current dataset schema.");
		return index;
	};
	const scalar = (index: unknown): number => {
		const result = column(index);
		requireSpec(!["binary", "nested"].includes(schema[result].basicType), "Transformation requires scalar fields.");
		return result;
	};
	const columns = (indexes: unknown): number[] => {
		requireSpec(Array.isArray(indexes) && indexes.length > 0 && indexes.length <= schema.length, "Transformation requires a nonempty bounded column selection.");
		const result = indexes.map(column);
		requireSpec(new Set(result).size === result.length, "Transformation column selections must be unique.");
		return result;
	};
	const name = (candidate: unknown, replacing = -1): string => {
		const result = string(candidate, 256);
		requireSpec(result.trim().length > 0 && !schema.some((entry) => entry.index !== replacing && entry.name === result), "Transformation column names must be nonempty and unique.");
		return result;
	};
	let nodes = 0;
	const expression = (candidate: unknown, depth = 0): TransformExpression => {
		requireSpec(++nodes <= 128 && depth <= 16, "Transformation expression exceeds the 128-node or 16-level limit.");
		requireSpec(object(candidate));
		switch (candidate.kind) {
			case "column":
				fields(candidate, ["kind", "column"]);
				return { kind: "column", column: scalar(candidate.column) };
			case "literal": {
				fields(candidate, ["kind", "value"]);
				if (typeof candidate.value === "number") requireSpec(Number.isFinite(candidate.value) && (!Number.isInteger(candidate.value) || Number.isSafeInteger(candidate.value)), "Expression numbers must be finite and safely representable.");
				return { kind: "literal", value: typeof candidate.value === "number" ? candidate.value : nullable(candidate.value) };
			}
			case "binary":
				fields(candidate, ["kind", "operator", "left", "right"]);
				return { kind: "binary", operator: choice(candidate.operator, ["add", "subtract", "multiply", "divide"]), left: expression(candidate.left, depth + 1), right: expression(candidate.right, depth + 1) };
			case "call": {
				fields(candidate, ["kind", "function", "args"]);
				const fn = choice(candidate.function, ["abs", "round", "lower", "upper", "trim", "length", "coalesce"]);
				requireSpec(Array.isArray(candidate.args) && (fn === "coalesce" ? candidate.args.length >= 2 && candidate.args.length <= 8 : candidate.args.length === 1), "Expression function has an invalid argument count.");
				return { kind: "call", function: fn, args: candidate.args.map((arg: unknown) => expression(arg, depth + 1)) };
			}
			default: throw new Error("Unsupported transformation expression.");
		}
	};
	const op = value.operation;
	requireSpec(object(op));
	let operation: TransformOperation;
	switch (op.kind) {
		case "rename": {
			fields(op, ["kind", "column", "name"]);
			const index = column(op.column);
			operation = { kind: "rename", column: index, name: name(op.name, index) };
			break;
		}
		case "cast":
			fields(op, ["kind", "column", "type", "invalid"]);
			operation = { kind: "cast", column: scalar(op.column), type: choice(op.type, ["text", "number", "integer", "boolean", "date", "timestamp"]), invalid: choice(op.invalid, ["error", "null"]) };
			break;
		case "drop": {
			fields(op, ["kind", "columns"]);
			const indexes = columns(op.columns);
			requireSpec(indexes.length < schema.length, "A transformation must retain at least one column.");
			operation = { kind: "drop", columns: indexes };
			break;
		}
		case "filter": {
			fields(op, ["kind", "column", "operator", "comparison", "value"]);
			const operator = choice(op.operator, ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "is-null", "not-null"]);
			const comparison = choice(op.comparison, ["text", "number"]);
			const operand = nullable(op.value);
			if (operator === "is-null" || operator === "not-null") requireSpec(operand === null && comparison === "text", "Null predicates require a null operand and text comparison.");
			else {
				requireSpec(operand !== null, "Value comparisons require a string operand.");
				requireSpec(operator !== "contains" || comparison === "text", "Contains requires text comparison.");
				if (comparison === "number") requireSpec(finiteNumber(operand) !== null, "Numeric filters require a finite decimal comparison.");
			}
			operation = { kind: "filter", column: scalar(op.column), operator, comparison, value: operand };
			break;
		}
		case "missing": {
			fields(op, ["kind", "columns", "method", "missing", "value"]);
			const indexes = columns(op.columns);
			const method = choice(op.method, ["constant", "mean", "median", "drop"]);
			const operand = nullable(op.value);
			requireSpec(method === "constant" || operand === null, "Only constant imputation accepts a replacement value.");
			if (method !== "drop") indexes.forEach(scalar);
			operation = { kind: "missing", columns: indexes, method, missing: choice(op.missing, ["null", "empty", "both"]), value: operand };
			break;
		}
		case "deduplicate":
			fields(op, ["kind", "columns"]);
			operation = { kind: "deduplicate", columns: columns(op.columns) };
			break;
		case "map": {
			fields(op, ["kind", "column", "entries", "unmatched"]);
			requireSpec(Array.isArray(op.entries) && op.entries.length >= 1 && op.entries.length <= 128, "Value maps require 1 to 128 entries.");
			const entries = op.entries.map((entry: unknown) => { fields(entry, ["from", "to"]); return { from: string(entry.from), to: nullable(entry.to) }; });
			requireSpec(new Set(entries.map((entry) => entry.from)).size === entries.length, "Value map keys must be unique.");
			operation = { kind: "map", column: scalar(op.column), entries, unmatched: choice(op.unmatched, ["keep", "null"]) };
			break;
		}
		case "datetime":
			fields(op, ["kind", "column", "component", "name"]);
			operation = { kind: "datetime", column: scalar(op.column), component: choice(op.component, ["year", "month", "day", "weekday", "hour"]), name: name(op.name) };
			break;
		case "scale":
			fields(op, ["kind", "column", "method", "name"]);
			operation = { kind: "scale", column: scalar(op.column), method: choice(op.method, ["standard", "minmax"]), name: name(op.name) };
			break;
		case "encode": {
			fields(op, ["kind", "column", "method", "categories", "name"]);
			requireSpec(Array.isArray(op.categories) && op.categories.length <= 128, "Encoding supports at most 128 categories.");
			const categories = op.categories.map((category: unknown) => string(category));
			requireSpec(new Set(categories).size === categories.length, "Encoding categories must be unique.");
			const method = choice(op.method, ["ordinal", "one-hot"]);
			const prefix = name(op.name);
			if (method === "one-hot") for (let index = 0; index < categories.length; index++) name(`${prefix}_${index}`);
			operation = { kind: "encode", column: scalar(op.column), method, categories, name: prefix };
			break;
		}
		case "derive":
			fields(op, ["kind", "name", "expression"]);
			operation = { kind: "derive", name: name(op.name), expression: expression(op.expression) };
			break;
		default: throw new Error("Unsupported transformation operation.");
	}
	if (["datetime", "scale", "derive", "encode"].includes(operation.kind)) {
		const added = operation.kind === "encode" && operation.method === "one-hot" ? Math.max(1, operation.categories.length) : 1;
		requireSpec(schema.length + added <= MAX_COLUMNS, "Transformation would exceed 512 columns.");
	}
	const spec: TransformSpec = { version: 1, datasetVersionId: versionId, operation };
	requireSpec(encoder.encode(JSON.stringify(spec)).byteLength <= TRANSFORM_SPEC_BYTES, "Transformation specification exceeds the supported size.");
	return spec;
}
