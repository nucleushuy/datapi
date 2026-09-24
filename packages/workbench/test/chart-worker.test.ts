import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { runAnalytical } from "../src/analytical-process.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import { chartColumns, isChartResult } from "../src/chart-validation.ts";
import type { DatasetColumn } from "../src/contracts.ts";
import { parseAnalyticalRequest } from "../src/format-validation.ts";
import type { ProfileInput } from "../src/profile-contracts.ts";

for (const [name, width, population, cell, limited] of [
	["systematic sampling", 2, 5000, "i::VARCHAR", false],
	["wide source narrow projection", 512, 800, "i::VARCHAR", false],
	["byte capped sample", 1, 40, "repeat('x',600000)", true],
	["empty source", 1, 0, "i::VARCHAR", false],
] as const) {
	test(`chart worker preserves source identity with ${name}`, { timeout: 60000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-chart-worker-"));
		try {
			const artifactPath = join(root, "data.duckdb");
			const instance = await DuckDBInstance.create(artifactPath, { threads: "1", memory_limit: "256MiB" });
			try {
				const connection = await instance.connect();
				try {
					await connection.run(
						`CREATE TABLE data AS SELECT i AS row_index, ${Array.from({ length: width }, (_, index) => `${cell} AS c${index}`).join(", ")} FROM range(${population}) t(i)`,
					);
					await connection.run("CHECKPOINT");
				} finally {
					connection.closeSync();
				}
			} finally {
				instance.closeSync();
			}
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
			const schema: DatasetColumn[] = Array.from({ length: width }, (_, index) => ({
				index,
				name: `field_${index}`,
				sourceType: "VARCHAR",
				basicType: "text",
			}));
			const input: ProfileInput = {
				datasetVersionId: randomUUID(),
				datasetVersionHash: hash.digest("hex"),
				rowCount: population,
				sourceBytes: 100,
				storageBytes: (await stat(artifactPath)).size,
				schema,
			};
			const spec = { ...defaultChartSpec(input.datasetVersionId), type: "bar" as const, x: width - 1 };
			const request = { kind: "chart" as const, artifactPath, tempPath: join(root, "temp"), input, spec };
			assert.deepEqual(parseAnalyticalRequest(request), request);
			const response = await runAnalytical(request);
			assert.equal(response.kind, "chart");
			if (response.kind !== "chart") throw new Error("Wrong worker response");
			const result = response.chart;
			assert.ok(isChartResult(result, input, spec));
			assert.equal(result.byteLimited, limited);
			assert.equal(result.populationRows, population);
			assert.ok(result.sampleSize <= 4096);
			assert.equal(result.sampled, result.sampleSize < population);
			assert.equal(result.table.columns.length, 1);
			assert.equal(result.table.columns[0].index, width - 1);
			assert.ok(result.table.rows.length <= 100);
			assert.ok(result.marks.length <= spec.categoryLimit);
			assert.ok(result.marks.every((mark) => mark.rowIds.every((id) => id % result.stride === 0)));
			if (name === "systematic sampling") {
				assert.equal(result.stride, 2);
				assert.equal(result.sampleSize, 2500);
				assert.ok(result.warnings.some((warning) => /sampl/i.test(warning)));
				assert.equal(isChartResult({ ...result, datasetVersionHash: "0".repeat(64) }, input, spec), false);
				assert.equal(isChartResult({ ...result, sampled: false }, input, spec), false);
				const invalid = structuredClone(result);
				invalid.marks[0].rowIds = [population];
				assert.equal(isChartResult(invalid, input, spec), false);
				await assert.rejects(
					runAnalytical({ ...request, input: { ...input, datasetVersionHash: "0".repeat(64) } }),
					/SHA-256/,
				);
				await assert.rejects(
					runAnalytical({ ...request, input: { ...input, rowCount: population + 1 } }),
					/schema/,
				);
				assert.throws(() => parseAnalyticalRequest({ ...request, spec: { ...spec, x: 999 } }), /specification/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("chart projections preserve encoding and filter indexes with bounded matrix fields", () => {
	const schema: DatasetColumn[] = Array.from({ length: 512 }, (_, index) => ({
		index,
		name: `c${index}`,
		sourceType: "DOUBLE",
		basicType: "number",
	}));
	const base = { ...defaultChartSpec("v1"), filters: [{ column: 511, op: "not-null" as const, value: "" }] };
	assert.deepEqual(
		chartColumns({ ...base, type: "scatter", x: 500, y: 501 }, schema).map((column) => column.index),
		[500, 501, 511],
	);
	assert.equal(chartColumns({ ...base, type: "correlation" }, schema).length, 13);
	assert.equal(chartColumns({ ...base, type: "missingness" }, schema).length, 25);
});
