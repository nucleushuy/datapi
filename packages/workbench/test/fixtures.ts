import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ColumnProfile } from "../src/contracts.ts";

const PARQUET_VALUES = `SELECT * FROM (VALUES
	(0, 9007199254740993::BIGINT, 18446744073709551615::UBIGINT,
	 '12345678901234567890.123456789012345678'::DECIMAL(38,18),
	 DATE '2026-09-23', TIMESTAMP '2026-09-23 12:34:56.123456', true, '', [1, 2]),
	(1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
) AS fixture(row_order, exact_integer, unsigned_integer, exact_decimal, day, instant, flag, label, items)`;

async function parquetQueryFixture(context: TestContext, query: string): Promise<Buffer> {
	const directory = await mkdtemp(join(tmpdir(), "datapi-parquet-fixture-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "trusted.parquet");
	const instance = await DuckDBInstance.create(":memory:", { threads: "1" });
	try {
		const connection = await instance.connect();
		try {
			await connection.run(`COPY (${query}) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET)`);
		} finally {
			connection.closeSync();
		}
	} finally {
		instance.closeSync();
	}
	return readFile(path);
}

/** COPY executes only these local, trusted fixture statements, never uploaded SQL. */
export async function parquetFixture(context: TestContext, empty = false): Promise<Buffer> {
	return parquetQueryFixture(
		context,
		`SELECT * EXCLUDE (row_order) FROM (${PARQUET_VALUES}) ${empty ? "WHERE false" : "ORDER BY row_order"}`,
	);
}

export async function mixedPrecisionFixture(context: TestContext): Promise<Buffer> {
	return parquetQueryFixture(
		context,
		`SELECT * EXCLUDE (row_order) FROM (VALUES
		(0, 9007199254740993::BIGINT, 1::BIGINT, 1::BIGINT),
		(1, 1, 9007199254740993, 2),
		(2, -2, -2, -2)
	) AS fixture(row_order, unsafe_first, unsafe_later, safe_integer) ORDER BY row_order`,
	);
}

interface LegacyDataset {
	id: string;
	projectId: string;
	name: string;
	createdAt: string;
	byteSize: number;
	sha256: string;
	rowCount: number;
	columnCount: number;
	columns: ColumnProfile[];
	parsing: { encoding: "utf-8"; delimiter: ","; header: true; emptyValues: "empty-string" };
	profileVersion: number;
	profiledAt: string;
}

export async function legacyFixture(
	root: string,
	source = "x\n001\n-2\n",
): Promise<{
	project: { id: string; name: string; createdAt: string };
	dataset: LegacyDataset;
	projectPath: string;
	metadataPath: string;
	sourcePath: string;
	rowsPath: string;
	indexPath: string;
}> {
	const createdAt = "2024-01-02T03:04:05.000Z";
	const project = { id: randomUUID(), name: "Legacy project", createdAt };
	const dataset: LegacyDataset = {
		id: randomUUID(),
		projectId: project.id,
		name: "original observations.csv",
		createdAt,
		byteSize: Buffer.byteLength(source),
		sha256: createHash("sha256").update(source).digest("hex"),
		rowCount: 2,
		columnCount: 1,
		columns: [{ index: 0, name: "x", inferredType: "number", emptyCount: 0, numericCount: 2, min: -2, max: 1 }],
		parsing: { encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" },
		profileVersion: 1,
		profiledAt: createdAt,
	};
	const directory = join(root, "projects", project.id, "datasets", dataset.id);
	await mkdir(directory, { recursive: true });
	const projectPath = join(root, "projects", project.id, "project.json");
	const metadataPath = join(directory, "metadata.json");
	const sourcePath = join(directory, "source.csv");
	const rowsPath = join(directory, "rows.jsonl");
	const indexPath = join(directory, "rows.index.json");
	await Promise.all([
		writeFile(projectPath, JSON.stringify(project)),
		writeFile(metadataPath, JSON.stringify(dataset)),
		writeFile(sourcePath, source),
		writeFile(rowsPath, '["001"]\n["-2"]\n'),
		writeFile(indexPath, JSON.stringify([0])),
	]);
	return { project, dataset, projectPath, metadataPath, sourcePath, rowsPath, indexPath };
}
