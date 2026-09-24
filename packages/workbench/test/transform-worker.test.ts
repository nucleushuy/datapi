import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { runAnalytical } from "../src/analytical-process.ts";
import type { DatasetColumn } from "../src/contracts.ts";
import { parseAnalyticalRequest } from "../src/format-validation.ts";
import type { ProfileInput } from "../src/profile-contracts.ts";
import type { TransformOperation, TransformSpec } from "../src/transform-contracts.ts";

interface TransformFixture {
	artifactPath: string;
	input: ProfileInput;
}

async function hash(path: string): Promise<string> {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
}
async function fixture(root: string, query: string, names: string[]): Promise<TransformFixture> {
	const artifactPath = join(root, `${randomUUID()}.duckdb`);
	const database = await DuckDBInstance.create(artifactPath, { threads: "1", memory_limit: "256MiB" });
	let rowCount = 0;
	try {
		const connection = await database.connect();
		try {
			await connection.run(`CREATE TABLE data AS ${query}`);
			const count = await connection.run("SELECT count(*) FROM data");
			const chunk = await count.fetchChunk();
			assert.ok(chunk);
			rowCount = Number(chunk.getRowValues(0)[0]);
			await connection.run("CHECKPOINT");
		} finally {
			connection.closeSync();
		}
	} finally {
		database.closeSync();
	}
	const schema: DatasetColumn[] = names.map((name, index) => ({
		index,
		name,
		sourceType: "VARCHAR",
		basicType: "text",
	}));
	return {
		artifactPath,
		input: {
			datasetVersionId: "fixture-v1",
			datasetVersionHash: await hash(artifactPath),
			rowCount,
			sourceBytes: 100,
			storageBytes: (await stat(artifactPath)).size,
			schema,
		},
	};
}
async function transform(root: string, source: TransformFixture, operation: TransformOperation) {
	const spec: TransformSpec = { version: 1, datasetVersionId: source.input.datasetVersionId, operation };
	const request = {
		kind: "transform" as const,
		...source,
		tempPath: join(root, `temp-${randomUUID()}`),
		outputPath: join(root, `result-${randomUUID()}.duckdb`),
		spec,
	};
	assert.deepEqual(parseAnalyticalRequest(request), request);
	const result = await runAnalytical(request);
	assert.equal(result.kind, "transform");
	if (result.kind !== "transform") throw new Error("Unexpected result");
	assert.equal(await hash(source.artifactPath), source.input.datasetVersionHash);
	assert.equal(result.impact.before.length, Math.min(source.input.rowCount, 20));
	assert.equal(result.impact.spec.datasetVersionId, source.input.datasetVersionId);
	assert.ok(result.impact.sql.includes("ORDER BY source_row_index"));
	const preview = await runAnalytical({
		kind: "preview",
		artifactPath: request.outputPath,
		tempPath: request.tempPath,
		offset: 0,
		limit: 20,
		total: result.impact.rowCount,
	});
	assert.equal(preview.kind, "preview");
	if (preview.kind !== "preview") throw new Error("Unexpected preview");
	assert.deepEqual(preview.preview.rows, result.impact.after);
	return { ...result.impact, outputPath: request.outputPath, request };
}

const inputQuery =
	"SELECT row_number() OVER () - 1 AS row_index, n::VARCHAR AS c0, category::VARCHAR AS c1, day::VARCHAR AS c2 FROM (VALUES ('1','b','2024-01-01'),('3','a','2024-01-02T23:00:00-02:00'),(NULL,'b','invalid'),('','',NULL),('3','a','2024-01-02T23:00:00-02:00')) t(n,category,day)";

test(
	"every operation materializes exact immutable rows and deterministic schemas through the isolated worker",
	{ timeout: 240000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-transform-"));
		try {
			const source = await fixture(root, inputQuery, ["number", "category", "day"]);
			const rename = await transform(root, source, { kind: "rename", column: 0, name: "renamed" });
			assert.equal(rename.affectedRows, 5);
			assert.deepEqual(
				rename.nullChanges.filter((entry) => entry.name === "number" || entry.name === "renamed"),
				[
					{ name: "number", before: 1, after: null },
					{ name: "renamed", before: null, after: 1 },
				],
			);
			const drop = await transform(root, source, { kind: "drop", columns: [0] });
			assert.deepEqual(
				drop.schema.map((entry) => entry.name),
				["category", "day"],
			);
			assert.deepEqual(drop.after[0], ["b", "2024-01-01"]);
			const filter = await transform(root, source, {
				kind: "filter",
				column: 0,
				operator: "gte",
				comparison: "number",
				value: "2",
			});
			assert.equal(filter.rowCount, 2);
			assert.equal(filter.affectedRows, 3);
			const injected = await transform(root, source, {
				kind: "filter",
				column: 1,
				operator: "eq",
				comparison: "text",
				value: "' OR 1=1 --",
			});
			assert.equal(injected.rowCount, 0);
			const dedup = await transform(root, source, { kind: "deduplicate", columns: [1] });
			assert.deepEqual(
				dedup.after.map((row) => row[0]),
				["1", "3", ""],
			);
			assert.equal(dedup.affectedRows, 2);
			const map = await transform(root, source, {
				kind: "map",
				column: 1,
				entries: [{ from: "b", to: "B' -- exact" }],
				unmatched: "keep",
			});
			assert.equal(map.affectedRows, 2);
			assert.equal(map.after[0][1], "B' -- exact");
			const date = await transform(root, source, { kind: "datetime", column: 2, component: "day", name: "utc_day" });
			assert.deepEqual(
				date.after.map((row) => row[3]),
				["1", "3", null, null, "3"],
			);
			const scale = await transform(root, source, { kind: "scale", column: 0, method: "minmax", name: "scaled" });
			assert.deepEqual(
				scale.after.map((row) => Number(row[3])),
				[0, 1, 0, 0, 1],
			);
			assert.equal(scale.after[2][3], null);
			assert.ok(scale.warnings.some((warning) => warning.includes("IEEE-754")));
			const encode = await transform(root, source, {
				kind: "encode",
				column: 1,
				method: "ordinal",
				categories: [],
				name: "code",
			});
			assert.deepEqual(
				encode.after.map((row) => row[3]),
				["2", "1", "2", "0", "1"],
			);
			assert.ok(encode.warnings.some((warning) => warning.includes('["","a","b"]')));
			const hot = await transform(root, source, {
				kind: "encode",
				column: 1,
				method: "one-hot",
				categories: ["b", "a"],
				name: "hot",
			});
			assert.deepEqual(
				hot.schema.slice(3).map((entry) => entry.name),
				["hot_0", "hot_1"],
			);
			assert.deepEqual(hot.after[3].slice(3), ["0", "0"]);
			const operation: TransformOperation = {
				kind: "derive",
				name: "derived",
				expression: {
					kind: "binary",
					operator: "divide",
					left: { kind: "column", column: 0 },
					right: { kind: "literal", value: 2 },
				},
			};
			const derive = await transform(root, source, operation);
			assert.deepEqual(
				derive.after.map((row) => row[3]),
				["0.5", "1.5", null, null, "1.5"],
			);
			const replay = await transform(root, source, operation);
			assert.deepEqual(replay.after, derive.after);
			assert.deepEqual(replay.schema, derive.schema);
			assert.equal(replay.sql, derive.sql);
			const constant = await transform(root, source, {
				kind: "missing",
				columns: [0],
				method: "constant",
				missing: "null",
				value: "missing",
			});
			assert.equal(constant.after[2][0], "missing");
			assert.equal(constant.after[3][0], "");
			assert.equal(constant.affectedRows, 1);
			const median = await transform(root, source, {
				kind: "missing",
				columns: [0],
				method: "median",
				missing: "both",
				value: null,
			});
			assert.equal(median.after[2][0], "3.0");
			assert.equal(median.affectedRows, 2);
			const mean = await transform(root, source, {
				kind: "missing",
				columns: [0],
				method: "mean",
				missing: "both",
				value: null,
			});
			assert.ok(Math.abs(Number(mean.after[2][0]) - 7 / 3) < 1e-12);
			const missingDrop = await transform(root, source, {
				kind: "missing",
				columns: [0],
				method: "drop",
				missing: "empty",
				value: null,
			});
			assert.equal(missingDrop.rowCount, 4);
			assert.equal(missingDrop.after[2][0], null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"cast policies, exact integers, finite arithmetic and zero variance have explicit behavior",
	{ timeout: 240000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-transform-casts-"));
		try {
			const numeric = await fixture(
				root,
				"SELECT i AS row_index, value::VARCHAR AS c0 FROM (VALUES (0::BIGINT,'9007199254740993'),(1,'1.5'),(2,'Infinity'),(3,''),(4,NULL)) t(i,value)",
				["n"],
			);
			const integer = await transform(root, numeric, { kind: "cast", column: 0, type: "integer", invalid: "null" });
			assert.deepEqual(integer.after, [["9007199254740993"], [null], [null], [null], [null]]);
			assert.equal(integer.columns[0].min, null);
			const number = await transform(root, numeric, { kind: "cast", column: 0, type: "number", invalid: "null" });
			assert.equal(number.after[2][0], null);
			await assert.rejects(
				transform(root, numeric, { kind: "cast", column: 0, type: "integer", invalid: "error" }),
				/cannot convert/,
			);
			const boolean = await fixture(
				root,
				"SELECT i AS row_index, value::VARCHAR AS c0 FROM (VALUES (0::BIGINT,'TRUE'),(1,'0'),(2,'yes')) t(i,value)",
				["enabled"],
			);
			assert.deepEqual(
				(await transform(root, boolean, { kind: "cast", column: 0, type: "boolean", invalid: "null" })).after,
				[["true"], ["false"], [null]],
			);
			const date = await fixture(root, "SELECT 0::BIGINT AS row_index, '2024-02-29'::VARCHAR AS c0", ["date"]);
			assert.deepEqual(
				(await transform(root, date, { kind: "cast", column: 0, type: "date", invalid: "error" })).after,
				[["2024-02-29"]],
			);
			assert.deepEqual(
				(await transform(root, date, { kind: "cast", column: 0, type: "timestamp", invalid: "error" })).after,
				[["2024-02-29T00:00:00.000000Z"]],
			);
			assert.deepEqual(
				(await transform(root, numeric, { kind: "cast", column: 0, type: "text", invalid: "error" })).after.map(
					(row) => row[0],
				),
				["9007199254740993", "1.5", "Infinity", "", null],
			);
			const constant = await fixture(root, "SELECT i AS row_index, '5'::VARCHAR AS c0 FROM range(3) t(i)", [
				"constant",
			]);
			assert.deepEqual(
				(await transform(root, constant, { kind: "scale", column: 0, method: "standard", name: "z" })).after.map(
					(row) => row[1],
				),
				["0.0", "0.0", "0.0"],
			);
			const zero = await transform(root, constant, {
				kind: "derive",
				name: "zero",
				expression: {
					kind: "binary",
					operator: "divide",
					left: { kind: "column", column: 0 },
					right: { kind: "literal", value: 0 },
				},
			});
			assert.ok(zero.after.every((row) => row[1] === null));
			for (const [fn, inputValue, expected] of [
				["abs", "-1.5", "1.5"],
				["round", "-1.5", "-2.0"],
				["lower", " AbC ", " abc "],
				["upper", " AbC ", " ABC "],
				["trim", " AbC ", "AbC"],
				["length", "a😀", "2"],
			] as const) {
				const result = await transform(root, constant, {
					kind: "derive",
					name: "result",
					expression: { kind: "call", function: fn, args: [{ kind: "literal", value: inputValue }] },
				});
				assert.equal(result.after[0][1], expected);
			}
			const coalesce = await transform(root, constant, {
				kind: "derive",
				name: "result",
				expression: {
					kind: "call",
					function: "coalesce",
					args: [
						{ kind: "literal", value: null },
						{ kind: "literal", value: "" },
						{ kind: "column", column: 0 },
					],
				},
			});
			assert.equal(coalesce.after[0][1], "");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"worker rejects invalid inputs and overwrite; cancellation rejects with caller-owned staging cleanup",
	{ timeout: 120000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-transform-errors-"));
		try {
			const source = await fixture(root, "SELECT i AS row_index, i::VARCHAR AS c0 FROM range(130) t(i)", ["n"]);
			const stage = await mkdtemp(join(root, "stage-"));
			const request = {
				kind: "transform" as const,
				...source,
				tempPath: join(stage, "scratch"),
				outputPath: join(stage, "output.duckdb"),
				spec: {
					version: 1 as const,
					datasetVersionId: source.input.datasetVersionId,
					operation: { kind: "rename" as const, column: 0, name: "renamed" },
				},
			};
			await assert.rejects(
				runAnalytical({ ...request, input: { ...source.input, datasetVersionHash: "0".repeat(64) } }),
				/SHA-256/,
			);
			await assert.rejects(runAnalytical({ ...request, input: { ...source.input, rowCount: 129 } }), /population/);
			assert.throws(() => parseAnalyticalRequest({ ...request, outputPath: source.artifactPath }), /aliases/);
			await writeFile(request.outputPath, "sentinel", { flag: "wx" });
			await assert.rejects(runAnalytical(request), /already exists/);
			assert.equal(await readFile(request.outputPath, "utf8"), "sentinel");
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(runAnalytical(request, undefined, controller.signal), /cancelled/);
			assert.equal(await readFile(request.outputPath, "utf8"), "sentinel");
			await rm(request.outputPath);
			await assert.rejects(
				transform(root, source, { kind: "encode", column: 0, method: "ordinal", categories: [], name: "code" }),
				/128/,
			);
			await assert.rejects(runAnalytical(request, undefined, controller.signal), /cancelled/);
			await assert.rejects(access(request.outputPath), { code: "ENOENT" });
			const running = new AbortController();
			let receivedProgress = false;
			await assert.rejects(
				runAnalytical(
					request,
					() => {
						if (receivedProgress) return;
						receivedProgress = true;
						running.abort();
					},
					running.signal,
				),
				/cancelled/,
			);
			assert.equal(receivedProgress, true);
			assert.equal(await hash(source.artifactPath), source.input.datasetVersionHash);
			// Progress delivery can trail worker completion. Cancellation rejects the result,
			// but the caller (WorkbenchStore in production) owns output and scratch cleanup.
			await rm(stage, { recursive: true, force: true });
			await assert.rejects(access(stage), { code: "ENOENT" });
			assert.equal(await hash(source.artifactPath), source.input.datasetVersionHash);
			const complete = await transform(root, source, {
				kind: "filter",
				column: 0,
				operator: "lt",
				comparison: "number",
				value: "100",
			});
			assert.equal(complete.rowCount, 100);
			assert.equal(complete.affectedRows, 30);
			assert.equal(complete.after.length, 20);
			const malformed = await fixture(root, "SELECT 7::BIGINT AS row_index, 'x'::VARCHAR AS c0", ["n"]);
			await assert.rejects(transform(root, malformed, { kind: "rename", column: 0, name: "renamed" }), /population/);
			const oversized = await fixture(root, "SELECT 0::BIGINT AS row_index, repeat('x', 1048576)::VARCHAR AS c0", [
				"large",
			]);
			await assert.rejects(transform(root, oversized, { kind: "rename", column: 0, name: "renamed" }), /1 MiB/);
			const expanded = await fixture(root, "SELECT 0::BIGINT AS row_index, repeat('x', 600000)::VARCHAR AS c0", [
				"large",
			]);
			await assert.rejects(
				transform(root, expanded, { kind: "derive", name: "copy", expression: { kind: "column", column: 0 } }),
				/1 MiB/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
