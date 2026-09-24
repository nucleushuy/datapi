import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { runAnalytical } from "../src/analytical-process.ts";
import type { DatasetColumn } from "../src/contracts.ts";
import { parseAnalyticalRequest } from "../src/format-validation.ts";
import type { ProfileInput } from "../src/profile-contracts.ts";
import { isDatasetProfile } from "../src/profile-validation.ts";

for (const [name, width, population, cell, byteLimited] of [
	["systematic row limit", 2, 5000, "i::VARCHAR", false],
	["wide schema and cell limit", 512, 800, "i::VARCHAR", false],
	["decoded sample byte limit", 1, 40, "repeat('x', 600000)", true],
	["header-only artifact", 1, 0, "i::VARCHAR", false],
	["full populated scan", 2, 5, "i::VARCHAR", false],
	["singleton statistics", 1, 1, "'42'", false],
	["constant statistics", 1, 5, "'42'", false],
	["extreme finite text", 1, 3, "CASE WHEN i = 0 THEN '-1.79e308' WHEN i = 1 THEN '0' ELSE '1.79e308' END", false],
] as const) {
	test(`fixed profiling worker enforces ${name}`, { timeout: 60_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-profile-worker-"));
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
				name: `column_${index}`,
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
			const request = { kind: "profile" as const, artifactPath, tempPath: join(root, "temp"), input };
			assert.deepEqual(parseAnalyticalRequest(request), request);
			const progress: number[] = [];
			const result = await runAnalytical(request, (value) => progress.push(value.rowCount));
			assert.equal(result.kind, "profile");
			if (result.kind !== "profile") throw new Error("Wrong worker kind");
			const report = result.profile;
			assert.ok(isDatasetProfile(report, input));
			assert.equal(report.sampling.byteLimited, byteLimited);
			assert.ok(report.sampling.sampleSize <= 4096);
			assert.ok(report.sampling.sampleSize * width <= 200_000);
			assert.equal(report.sampling.approximate, report.sampling.sampleSize < population);
			assert.equal(progress.at(-1), report.sampling.sampleSize);
			assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
			assert.equal(report.rowCount, population);
			assert.equal(report.columnCount, width);
			if (name === "singleton statistics") {
				assert.equal(report.columns[0].numeric?.standardDeviation, null);
				assert.equal(report.columns[0].numeric?.skewness, null);
			}
			if (name === "constant statistics") assert.equal(report.columns[0].numeric?.standardDeviation, 0);
			if (name === "full populated scan") {
				assert.equal(report.columns[0].numeric?.median, 2);
				assert.equal(report.sampling.method, "full");
				for (const mutate of [
					(value: typeof report) => {
						value.columns[0].nullPercentage = 100;
					},
					(value: typeof report) => {
						if (value.columns[0].numeric) value.columns[0].numeric.standardDeviation = -1;
					},
					(value: typeof report) => {
						if (value.columns[0].numeric) value.columns[0].numeric.quantiles.p25 = 999;
					},
					(value: typeof report) => {
						if (value.columns[0].numeric) value.columns[0].numeric.excludedCount = 999;
					},
					(value: typeof report) => {
						value.sampling.sampleSize = 0;
					},
					(value: typeof report) => {
						value.issues[0].evidence[0].rows = 999;
					},
				]) {
					const invalid = structuredClone(report);
					mutate(invalid);
					assert.equal(isDatasetProfile(invalid, input), false);
				}
			}
			if (name === "systematic row limit") {
				assert.equal(report.sampling.stride, 2);
				assert.equal(report.sampling.sampleSize, 2500);
				assert.equal(report.columns[0].numeric?.max, 4998);
				const invalid = structuredClone(report);
				invalid.sampling.approximate = false;
				assert.equal(isDatasetProfile(invalid, input), false);
				await assert.rejects(
					runAnalytical({ ...request, input: { ...input, datasetVersionHash: "0".repeat(64) } }),
					/SHA-256/,
				);
				await assert.rejects(
					runAnalytical({ ...request, input: { ...input, rowCount: population + 1 } }),
					/schema/,
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
