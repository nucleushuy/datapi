import type { DuckDBConnection } from "@duckdb/node-api";
import { type DatasetColumn, MAX_COLUMNS } from "./contracts.ts";
import { fail, sqlString } from "./format-validation.ts";
import type { TransformExpression, TransformSpec } from "./transform-contracts.ts";

const DECIMAL = "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?";
const ISO =
	"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?";
const APPROXIMATION =
	"Numeric conversions and arithmetic use IEEE-754 double precision and may approximate large integers and decimals; unchanged source strings remain exact.";
const CONVERSION_ERROR = "Transformation cannot convert one or more values under the requested policy.";

function literal(value: string | null): string {
	return value === null ? "NULL::VARCHAR" : sqlString(value);
}
function finite(sql: string): string {
	return `CASE WHEN isfinite(${sql}) THEN ${sql} ELSE NULL END`;
}
function numeric(sql: string): string {
	return `CASE WHEN regexp_full_match(${sql}, ${sqlString(DECIMAL)}) THEN ${finite(`TRY_CAST(${sql} AS DOUBLE)`)} ELSE NULL END`;
}
function datetime(sql: string): string {
	return `CASE WHEN regexp_full_match(${sql}, ${sqlString(ISO)}) THEN TRY_CAST(${sql} AS TIMESTAMPTZ) ELSE NULL END`;
}
function missing(sql: string, mode: "null" | "empty" | "both"): string {
	return mode === "null"
		? `${sql} IS NULL`
		: mode === "empty"
			? `coalesce(${sql} = '', false)`
			: `(${sql} IS NULL OR ${sql} = '')`;
}
function outputColumn(
	name: string,
	index: number,
	basicType: DatasetColumn["basicType"],
	sourceType: string,
): DatasetColumn {
	return { name, index, basicType, sourceType };
}

export interface TransformPlan {
	sql: string;
	schema: DatasetColumn[];
	warnings: string[];
	removedRows: boolean;
}

/** Only fixed operators, cN identifiers and escaped data literals enter these queries. */
export async function createTransformPlan(
	connection: DuckDBConnection,
	spec: TransformSpec,
	input: DatasetColumn[],
): Promise<TransformPlan> {
	const op = spec.operation;
	let schema = input.map((entry) => ({ ...entry }));
	let expressions = input.map((_, index) => `c${index}`);
	let where = "";
	let qualify = "";
	let joins = "";
	let changed = "false";
	let removedRows = false;
	const warnings = [
		"Impact counts cover the complete dataset. SQL NULL and empty string are distinct. Preview samples are the first bounded rows, not an aligned diff.",
	];
	const check = async (predicate: string): Promise<void> => {
		const result = await connection.run(`SELECT 1 FROM data WHERE ${predicate} LIMIT 1`);
		const chunk = await result.fetchChunk();
		if (chunk && chunk.rowCount > 0) fail(CONVERSION_ERROR);
	};
	const add = (name: string, expression: string, type: DatasetColumn["basicType"], sourceType: string): void => {
		if (schema.some((entry) => entry.name === name) || schema.length >= MAX_COLUMNS)
			fail("Transformation encoding exceeds 128 categories or 512 columns.");
		schema.push(outputColumn(name, schema.length, type, sourceType));
		expressions.push(expression);
		changed = "true";
	};
	const changedColumn = (index: number, expression: string): void => {
		expressions[index] = expression;
		changed = `(${expression}) IS DISTINCT FROM c${index}`;
	};
	switch (op.kind) {
		case "rename":
			schema[op.column].name = op.name;
			changed = op.name === input[op.column].name ? "false" : "true";
			break;
		case "drop":
			schema = schema
				.filter((entry) => !op.columns.includes(entry.index))
				.map((entry, index) => ({ ...entry, index }));
			expressions = expressions.filter((_, index) => !op.columns.includes(index));
			changed = "true";
			break;
		case "cast": {
			const col = `c${op.column}`;
			let converted = col;
			let type: DatasetColumn["basicType"] = "text";
			let sourceType = "VARCHAR";
			if (op.type === "number") {
				converted = `CAST(${numeric(col)} AS VARCHAR)`;
				type = "number";
				sourceType = "DOUBLE";
				warnings.push(APPROXIMATION);
			}
			if (op.type === "integer") {
				converted = `CASE WHEN regexp_full_match(${col}, '[+-]?[0-9]+') THEN CAST(TRY_CAST(${col} AS BIGINT) AS VARCHAR) ELSE NULL END`;
				type = "number";
				sourceType = "BIGINT";
			}
			if (op.type === "boolean") {
				converted = `CASE WHEN lower(${col}) IN ('true', 'false') THEN lower(${col}) WHEN ${col} = '1' THEN 'true' WHEN ${col} = '0' THEN 'false' ELSE NULL END`;
				type = "boolean";
				sourceType = "BOOLEAN";
			}
			if (op.type === "date") {
				converted = `CASE WHEN regexp_full_match(${col}, '[0-9]{4}-[0-9]{2}-[0-9]{2}') THEN CAST(TRY_CAST(${col} AS DATE) AS VARCHAR) ELSE NULL END`;
				type = "datetime";
				sourceType = "DATE";
			}
			if (op.type === "timestamp") {
				converted = `strftime(${datetime(col)}, '%Y-%m-%dT%H:%M:%S.%fZ')`;
				type = "datetime";
				sourceType = "TIMESTAMPTZ";
			}
			if (op.invalid === "error") await check(`${col} IS NOT NULL AND (${converted}) IS NULL`);
			warnings.push(
				`Cast invalid policy: ${op.invalid}; SQL NULL remains NULL. Integer accepts signed integer syntax in BIGINT range; boolean accepts true/false (case-insensitive) and 1/0; dates require ISO YYYY-MM-DD; timestamps require ISO date or seconds precision date-time, interpreted in UTC when no offset is supplied.`,
			);
			schema[op.column] = outputColumn(input[op.column].name, op.column, type, sourceType);
			changedColumn(op.column, converted);
			break;
		}
		case "filter": {
			const col = `c${op.column}`;
			let predicate: string;
			if (op.operator === "is-null") predicate = `${col} IS NULL`;
			else if (op.operator === "not-null") predicate = `${col} IS NOT NULL`;
			else if (op.operator === "contains") predicate = `contains(${col}, ${literal(op.value)})`;
			else {
				const operators = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
				predicate = `${op.comparison === "number" ? numeric(col) : col} ${operators[op.operator]} ${op.comparison === "number" ? numeric(literal(op.value)) : literal(op.value)}`;
			}
			where = `WHERE ${predicate}`;
			removedRows = true;
			warnings.push(
				"Filters retain only true predicates; NULL and invalid numeric comparisons do not match (including not-equal). Text comparisons are case-sensitive, untrimmed binary comparisons.",
			);
			if (op.comparison === "number") warnings.push(APPROXIMATION);
			break;
		}
		case "missing": {
			if (op.method === "drop") {
				where = `WHERE NOT (${op.columns.map((index) => missing(`c${index}`, op.missing)).join(" OR ")})`;
				removedRows = true;
				break;
			}
			const changes: string[] = [];
			for (const index of op.columns) {
				const col = `c${index}`;
				const predicate = missing(col, op.missing);
				let replacement = literal(op.value);
				if (op.method === "mean" || op.method === "median") {
					await check(`NOT (${predicate}) AND ${col} IS NOT NULL AND (${numeric(col)}) IS NULL`);
					const aggregate = op.method === "mean" ? "avg" : "median";
					replacement = `CAST((SELECT ${finite(`${aggregate}(${numeric(col)})`)} FROM data WHERE NOT (${predicate})) AS VARCHAR)`;
					warnings.push(
						APPROXIMATION,
						"Mean/median use all finite nonmissing observations. A field with no eligible observations remains NULL; invalid nonmissing numeric values cause failure.",
					);
				}
				const result = `CASE WHEN ${predicate} THEN ${replacement} ELSE ${col} END`;
				expressions[index] = result;
				changes.push(`(${result}) IS DISTINCT FROM ${col}`);
				// Imputation may mix exact source strings and a new constant; never misrepresent this as a typed cast.
				schema[index] = outputColumn(input[index].name, index, "text", "VARCHAR");
			}
			changed = changes.join(" OR ");
			break;
		}
		case "deduplicate":
			qualify = `QUALIFY row_number() OVER (PARTITION BY ${op.columns.map((index) => `c${index}`).join(", ")} ORDER BY row_index) = 1`;
			removedRows = true;
			warnings.push(
				"Deduplication compares exact selected strings, groups NULL with NULL (not empty string), and retains the first original row.",
			);
			break;
		case "map": {
			const col = `c${op.column}`;
			changedColumn(
				op.column,
				`CASE ${col} ${op.entries.map((entry) => `WHEN ${literal(entry.from)} THEN ${literal(entry.to)}`).join(" ")} ELSE ${op.unmatched === "keep" ? col : "NULL"} END`,
			);
			schema[op.column] = outputColumn(input[op.column].name, op.column, "text", "VARCHAR");
			break;
		}
		case "datetime":
			add(
				op.name,
				`CAST(date_part('${op.component === "weekday" ? "isodow" : op.component}', ${datetime(`c${op.column}`)}) AS VARCHAR)`,
				"number",
				"BIGINT",
			);
			warnings.push(
				"Datetime extraction uses ISO dates/times, UTC and ISO weekday Monday=1 to Sunday=7; missing or invalid dates become NULL. Offset-free values are UTC.",
			);
			break;
		case "scale": {
			const number = numeric(`c${op.column}`);
			const center = op.method === "standard" ? "avg" : "min";
			const denominator = op.method === "standard" ? `stddev_pop(${number})` : `max(${number}) - min(${number})`;
			joins = `CROSS JOIN (SELECT ${center}(${number}) AS center, ${denominator} AS spread FROM data) scale_stats`;
			add(
				op.name,
				`CAST(CASE WHEN (${number}) IS NULL THEN NULL WHEN spread = 0 THEN 0 ELSE ${finite(`((${number}) - center) / spread`)} END AS VARCHAR)`,
				"number",
				"DOUBLE",
			);
			warnings.push(
				APPROXIMATION,
				"Scaling uses the entire finite numeric population (population standard deviation); NULL/invalid inputs and nonfinite arithmetic become NULL; zero variance/range maps finite values to 0.",
			);
			break;
		}
		case "encode": {
			let categories = op.categories;
			if (categories.length === 0) {
				categories = [];
				let categoryBytes = 0;
				const result = await connection.run(
					`SELECT DISTINCT c${op.column} FROM data WHERE c${op.column} IS NOT NULL ORDER BY c${op.column} LIMIT 129`,
				);
				for (;;) {
					const chunk = await result.fetchChunk();
					if (!chunk || chunk.rowCount === 0) break;
					for (let row = 0; row < chunk.rowCount; row++) {
						const category = chunk.getRowValues(row)[0];
						if (typeof category !== "string") fail(CONVERSION_ERROR);
						categoryBytes += Buffer.byteLength(JSON.stringify(category));
						if (categoryBytes > 128 * 1024) fail("Transformation result exceeds the supported report size.");
						categories.push(category);
					}
				}
			}
			if (categories.length > 128 || (op.method === "one-hot" && categories.length === 0))
				fail("Transformation encoding exceeds 128 categories or 512 columns.");
			const col = `c${op.column}`;
			if (op.method === "ordinal")
				add(
					op.name,
					categories.length
						? `CASE ${col} ${categories.map((category, index) => `WHEN ${literal(category)} THEN '${index}'`).join(" ")} ELSE NULL END`
						: "NULL::VARCHAR",
					"number",
					"BIGINT",
				);
			else
				categories.forEach((category, index) => {
					add(
						`${op.name}_${index}`,
						`CASE WHEN ${col} IS NULL THEN NULL WHEN ${col} = ${literal(category)} THEN '1' ELSE '0' END`,
						"number",
						"BIGINT",
					);
				});
			warnings.push(
				`Encoding categories in index order: ${JSON.stringify(categories)}. ${op.categories.length ? "Explicit order retained." : "Discovered from the complete input in binary sorted order."} Unknown categories map to NULL ordinal or all-zero one-hot; input NULL maps to NULL in every encoding column.`,
			);
			break;
		}
		case "derive": {
			let next = 0;
			const compile = (
				expression: TransformExpression,
			): { sql: string; type: DatasetColumn["basicType"]; sourceType: string } => {
				if (expression.kind === "column")
					return {
						sql: `c${expression.column}`,
						type: input[expression.column].basicType,
						sourceType: input[expression.column].sourceType,
					};
				if (expression.kind === "literal")
					return {
						sql: literal(expression.value === null ? null : String(expression.value)),
						type: typeof expression.value === "number" ? "number" : "text",
						sourceType: typeof expression.value === "number" ? "DOUBLE" : "VARCHAR",
					};
				let expressionSql: string;
				let type: DatasetColumn["basicType"] = "number";
				if (expression.kind === "binary") {
					const left = compile(expression.left).sql;
					const right = compile(expression.right).sql;
					const operator = { add: "+", subtract: "-", multiply: "*", divide: "/" }[expression.operator];
					expressionSql = `CAST(${finite(`(${numeric(left)}) ${operator} (${numeric(right)})`)} AS VARCHAR)`;
				} else {
					const args = expression.args.map((arg) => compile(arg).sql);
					if (expression.function === "abs" || expression.function === "round")
						expressionSql = `CAST(${expression.function}(${numeric(args[0])}) AS VARCHAR)`;
					else if (expression.function === "length") expressionSql = `CAST(length(${args[0]}) AS VARCHAR)`;
					else {
						expressionSql = `${expression.function}(${args.join(", ")})`;
						type = "text";
					}
				}
				const alias = `e${next++}`;
				joins += ` CROSS JOIN LATERAL (SELECT ${expressionSql} AS ${alias}) expr_${alias}`;
				return { sql: alias, type, sourceType: type === "number" ? "DOUBLE" : "VARCHAR" };
			};
			const expression = compile(op.expression);
			add(op.name, expression.sql, expression.type, expression.sourceType);
			warnings.push(
				APPROXIMATION,
				"Derived numeric operations accept only finite decimal strings; invalid values, division by zero and nonfinite results become NULL. Text functions preserve NULL; coalesce chooses the first non-NULL value, including empty string; round is to integer, half away from zero; length counts Unicode characters.",
			);
			break;
		}
	}
	// __changed is an audit-only field, consumed by the worker but never persisted as a dataset column.
	const sql = `SELECT row_number() OVER (ORDER BY source_row_index) - 1 AS row_index, ${schema.map((_, index) => `c${index}`).join(", ")}, __changed FROM (SELECT row_index AS source_row_index, ${expressions.map((expression, index) => `${expression} AS c${index}`).join(", ")}, (${changed}) AS __changed FROM data ${joins} ${where} ${qualify}) transformed ORDER BY source_row_index`;
	return { sql, schema, warnings: [...new Set(warnings)], removedRows };
}
