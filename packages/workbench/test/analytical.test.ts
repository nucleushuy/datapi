import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { runAnalytical } from "../src/analytical-process.ts";

for (const [name, query, expected] of [
	["decoded record", "SELECT repeat('x', 1048576)::VARCHAR AS value", /1 MiB/],
	[
		"row-group expansion",
		"SELECT repeat('x', 1024) || i::VARCHAR AS value FROM range(70000) t(i)",
		/declared decoded-size/,
	],
	["column count", `SELECT ${Array.from({ length: 513 }, (_, i) => `${i} AS c${i}`).join(", ")}`, /512 columns/],
] as const) {
	test(`Parquet rejects ${name} before publishing any analytical artifact`, { timeout: 120_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-parquet-boundary-"));
		const sourcePath = join(root, "source.parquet");
		const artifactPath = join(root, "data.duckdb");
		try {
			const instance = await DuckDBInstance.create(":memory:", { threads: "1", memory_limit: "256MiB" });
			try {
				const connection = await instance.connect();
				try {
					await connection.run(
						`COPY (${query}) TO '${sourcePath.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`,
					);
				} finally {
					connection.closeSync();
				}
			} finally {
				instance.closeSync();
			}
			const bytes = await readFile(sourcePath);
			assert.ok(bytes.length < 100_000_000);
			await assert.rejects(
				runAnalytical({
					kind: "ingest",
					format: "parquet",
					sourcePath,
					artifactPath,
					tempPath: join(root, "temp"),
					expectedByteSize: bytes.length,
					expectedSha256: createHash("sha256").update(bytes).digest("hex"),
				}),
				expected,
			);
			assert.ok(!(await readdir(root)).some((path) => path.startsWith("data.duckdb")));
			assert.deepEqual(await readFile(sourcePath), bytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
