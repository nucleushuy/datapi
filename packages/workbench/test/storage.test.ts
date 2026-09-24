import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Dataset, ImportJob } from "../src/contracts.ts";
import {
	MAX_COLUMNS,
	MAX_PREVIEW_BYTES,
	MAX_RECORD_BYTES,
	MAX_UPLOAD_BYTES,
	PAGE_SIZE,
	PROFILE_VERSION,
} from "../src/contracts.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";
import { mixedPrecisionFixture, parquetFixture } from "./fixtures.ts";

async function fixture(context: TestContext): Promise<{ root: string; store: WorkbenchStore; projectId: string }> {
	const root = await mkdtemp(join(tmpdir(), "workbench-store-"));
	const store = new WorkbenchStore(root);
	context.after(async () => {
		await store.close();
		await rm(root, { recursive: true, force: true });
	});
	await store.init();
	const project = await store.createProject(" Test project ");
	assert.equal(project.name, "Test project");
	return { root, store, projectId: project.id };
}

async function* bytes(value: string | Uint8Array, chunkSize = 16 * 1024): AsyncGenerator<Uint8Array> {
	const buffer = typeof value === "string" ? Buffer.from(value) : value;
	for (let offset = 0; offset < buffer.length; offset += chunkSize) yield buffer.subarray(offset, offset + chunkSize);
}

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") return job;
		await nextTurn();
	}
	throw new Error("Job did not reach a terminal state within 120 seconds.");
}

async function imported(
	store: WorkbenchStore,
	projectId: string,
	value: string | Uint8Array,
	name = "data.csv",
): Promise<Dataset> {
	const job = await store.createImport(projectId, name);
	const processing = await store.upload(projectId, job.id, bytes(value));
	assert.equal(processing.state, "processing");
	const completed = await waitJob(store, projectId, job.id);
	assert.equal(completed.state, "completed", completed.error);
	assert.ok(completed.datasetId);
	return store.getDataset(projectId, completed.datasetId);
}

function status(expected: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === expected;
}

function stalledUpload(): { source: AsyncIterable<Uint8Array>; started: Promise<void>; returned: () => boolean } {
	let notify!: () => void;
	const started = new Promise<void>((resolve) => {
		notify = resolve;
	});
	let returning = false;
	const source: AsyncIterable<Uint8Array> = {
		[Symbol.asyncIterator]() {
			let first = true;
			return {
				next(): Promise<IteratorResult<Uint8Array>> {
					if (first) {
						first = false;
						return Promise.resolve({ done: false, value: Buffer.from("x\n1\n") });
					}
					notify();
					return new Promise(() => {});
				},
				return(): Promise<IteratorResult<Uint8Array>> {
					returning = true;
					return Promise.resolve({ done: true, value: undefined });
				},
			};
		},
	};
	return { source, started, returned: () => returning };
}

describe("WorkbenchStore", () => {
	it(
		"preserves BOM, quoted multiline strings and provenance with exact deterministic profiles",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const source =
				'\uFEFFid,note,flag,missing,mixed\r\n001,"a,b\nline ""two""",true,,3\r\n-2,plain,false,,text\r\n, ,,,4e2\r\n';
			const dataset = await imported(store, projectId, source);
			assert.equal(dataset.byteSize, Buffer.byteLength(source));
			assert.equal(dataset.sha256, createHash("sha256").update(source).digest("hex"));
			assert.equal(dataset.profileVersion, PROFILE_VERSION);
			assert.deepEqual(dataset.parsing, {
				format: "csv",
				encoding: "utf-8",
				delimiter: ",",
				header: true,
				emptyValues: "empty-string",
			});
			assert.equal(dataset.rowCount, 3);
			assert.equal(dataset.columnCount, 5);
			assert.deepEqual(dataset.columns, [
				{ index: 0, name: "id", inferredType: "number", emptyCount: 1, numericCount: 2, min: -2, max: 1 },
				{ index: 1, name: "note", inferredType: "text", emptyCount: 0, numericCount: 0, min: null, max: null },
				{ index: 2, name: "flag", inferredType: "boolean", emptyCount: 1, numericCount: 0, min: null, max: null },
				{ index: 3, name: "missing", inferredType: "empty", emptyCount: 3, numericCount: 0, min: null, max: null },
				{ index: 4, name: "mixed", inferredType: "text", emptyCount: 0, numericCount: 2, min: 3, max: 400 },
			]);
			assert.deepEqual((await store.preview(projectId, dataset.id, 0)).rows, [
				["001", 'a,b\nline "two"', "true", "", "3"],
				["-2", "plain", "false", "", "text"],
				["", " ", "", "", "4e2"],
			]);
			assert.deepEqual(await readFile(join(root, dataset.storageLocation)), Buffer.from(source));
			assert.equal(dataset.format, "csv");
			assert.equal(dataset.originalFilename, "data.csv");
			assert.equal(dataset.schemaVersion, 2);
			assert.equal(dataset.ingestionStatus, "ready");
			assert.equal(dataset.versions.length, 2);
			const sourceVersion = dataset.versions.find((version) => version.id === dataset.sourceVersionId);
			const derivedVersion = dataset.versions.find((version) => version.id === dataset.currentVersionId);
			assert.ok(sourceVersion && derivedVersion);
			assert.equal(sourceVersion.kind, "source");
			assert.equal(sourceVersion.parentVersionId, null);
			assert.equal(sourceVersion.storageLocation, dataset.storageLocation);
			assert.equal(derivedVersion.kind, "derived");
			assert.equal(derivedVersion.parentVersionId, sourceVersion.id);
			assert.equal(derivedVersion.operation.engine, "duckdb");
			assert.notEqual(derivedVersion.storageLocation, sourceVersion.storageLocation);
			assert.ok((await readFile(join(root, derivedVersion.storageLocation))).byteLength > 0);
			assert.deepEqual(await readdir(join(root, "staging")), []);
			dataset.columns[0].name = "mutated";
			assert.equal((await store.getDataset(projectId, dataset.id)).columns[0].name, "id");
		},
	);

	it(
		"seeks bounded preview pages at arbitrary offsets and handles header-only CSV",
		{ timeout: 120_000 },
		async (context) => {
			const { store, projectId } = await fixture(context);
			const dataset = await imported(
				store,
				projectId,
				`id,value\n${Array.from({ length: 205 }, (_, index) => `${index},row-${index}\n`).join("")}`,
			);
			const page = await store.preview(projectId, dataset.id, 99);
			assert.equal(page.limit, PAGE_SIZE);
			assert.equal(page.total, 205);
			assert.equal(page.rows.length, 100);
			assert.deepEqual(page.rows[0], ["99", "row-99"]);
			assert.deepEqual(page.rows[99], ["198", "row-198"]);
			assert.equal((await store.preview(projectId, dataset.id, 200)).rows.length, 5);
			assert.deepEqual((await store.preview(projectId, dataset.id, 205)).rows, []);
			for (const offset of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				await assert.rejects(store.preview(projectId, dataset.id, offset), status(400));
			}
			for (const limit of [1, 25, 500]) {
				const limited = await store.preview(projectId, dataset.id, 1, limit);
				assert.equal(limited.limit, limit);
				assert.equal(limited.rows.length, Math.min(limit, 204));
				assert.deepEqual(limited.rows[0], ["1", "row-1"]);
			}
			for (const limit of [0, -1, 1.5, 501, Infinity, Number.NaN]) {
				await assert.rejects(store.preview(projectId, dataset.id, 0, limit), status(400));
			}
			const empty = await imported(store, projectId, "id,value\n");
			assert.equal(empty.rowCount, 0);
			assert.ok(empty.columns.every((column) => column.inferredType === "empty" && column.emptyCount === 0));
			assert.deepEqual((await store.preview(projectId, empty.id, 0)).rows, []);
		},
	);

	it("caps preview bytes independently of row count without skipping rows", { timeout: 120_000 }, async (context) => {
		const { store, projectId } = await fixture(context);
		const value = "\u0001".repeat(100_000);
		assert.ok(Buffer.byteLength(JSON.stringify(["19", value])) + 1 <= MAX_RECORD_BYTES);
		const dataset = await imported(
			store,
			projectId,
			`id,value\n${Array.from({ length: 20 }, (_, index) => `${index},${value}\n`).join("")}`,
		);
		assert.equal(dataset.rowCount, 20);
		const page = await store.preview(projectId, dataset.id, 0);
		assert.ok(page.rows.length > 0 && page.rows.length < 20);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_PREVIEW_BYTES);
		const remaining = await store.preview(projectId, dataset.id, page.rows.length);
		assert.ok(remaining.rows.length > 0);
		assert.ok(Buffer.byteLength(JSON.stringify(remaining)) <= MAX_PREVIEW_BYTES);
		assert.equal(page.rows.length + remaining.rows.length, 20);
		const allRows = [...page.rows, ...remaining.rows];
		assert.deepEqual(
			allRows.map((row) => row[0]),
			Array.from({ length: 20 }, (_, index) => String(index)),
		);
		assert.ok(allRows.every((row) => row[1] === value));
	});

	it(
		"rejects malformed headers, column counts, quotes, UTF-8 and oversized records safely",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			for (const value of [
				"x,x\n1,2\n",
				"x,\n1,2\n",
				" \n1\n",
				"x,y\n1\n",
				'x\n"private unfinished',
				'x\nprivate"quote\n',
				Buffer.from([0x78, 0x0a, 0xff]),
				Buffer.from([0x78, 0x0a, 0xe2, 0x82]),
				`x\n${"a".repeat(MAX_RECORD_BYTES + 1)}\n`,
				`${Array.from({ length: MAX_COLUMNS + 1 }, (_, index) => `column${index}`).join(",")}\n`,
			]) {
				const job = await store.createImport(projectId, "bad.csv");
				await store.upload(projectId, job.id, bytes(value));
				const failed = await waitJob(store, projectId, job.id);
				assert.equal(failed.state, "failed");
				assert.ok(failed.error);
				assert.ok(!failed.error.includes("private"));
				assert.equal(failed.datasetId, undefined);
				assert.deepEqual(await store.listDatasets(projectId), []);
				assert.deepEqual(await readdir(join(root, "staging")), []);
			}
			const blank = await store.createImport(projectId, "empty.csv");
			await assert.rejects(store.upload(projectId, blank.id, bytes("")), status(400));
			assert.equal(store.getJob(projectId, blank.id).state, "failed");
		},
	);

	it(
		"enforces raw upload size before publication and cleans up rejected sources",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const chunk = Buffer.alloc(1024 * 1024, 0x78);
			let finalized = false;
			async function* oversized(): AsyncGenerator<Uint8Array> {
				try {
					for (let total = 0; total <= MAX_UPLOAD_BYTES; total += chunk.length) yield chunk;
				} finally {
					finalized = true;
				}
			}
			const job = await store.createImport(projectId, "large.csv");
			await assert.rejects(store.upload(projectId, job.id, oversized()), status(413));
			assert.ok(finalized);
			assert.equal(store.getJob(projectId, job.id).state, "failed");
			assert.ok(store.getJob(projectId, job.id).bytesReceived <= MAX_UPLOAD_BYTES);
			assert.deepEqual(await store.listDatasets(projectId), []);
			assert.deepEqual(await readdir(join(root, "staging")), []);
		},
	);

	it(
		"serializes reservations and duplicate uploads, snapshots progress and cancels a stalled source",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const results = await Promise.allSettled([
				store.createImport(projectId, "a.csv"),
				store.createImport(projectId, "b.csv"),
			]);
			const accepted = results.find((result) => result.status === "fulfilled");
			assert.ok(accepted?.status === "fulfilled");
			assert.equal(results.filter((result) => result.status === "rejected").length, 1);
			const job = accepted.value;
			const stalled = stalledUpload();
			const upload = assert.rejects(store.upload(projectId, job.id, stalled.source), status(409));
			await stalled.started;
			assert.equal(store.getJob(projectId, job.id).bytesReceived, 4);
			const snapshot = store.getJob(projectId, job.id);
			snapshot.state = "completed";
			assert.equal(store.getJob(projectId, job.id).state, "uploading");
			await assert.rejects(store.upload(projectId, job.id, bytes("x\n2\n")), status(409));
			assert.equal((await store.cancel(projectId, job.id)).state, "cancelled");
			await upload;
			assert.ok(stalled.returned());
			assert.deepEqual(await readdir(join(root, "staging")), []);
			assert.deepEqual(await store.listDatasets(projectId), []);
			const next = await store.createImport(projectId, "next.csv");
			await store.cancel(projectId, next.id);
		},
	);

	it("cancels processing and shutdown without publishing partial datasets", { timeout: 120_000 }, async (context) => {
		const { root, store, projectId } = await fixture(context);
		const job = await store.createImport(projectId, "processing.csv");
		await store.upload(projectId, job.id, bytes(`x\n${"1\n".repeat(100_000)}`));
		assert.equal((await store.cancel(projectId, job.id)).state, "cancelled");
		assert.deepEqual(await store.listDatasets(projectId), []);
		const pending = await store.createImport(projectId, "shutdown.csv");
		const stalled = stalledUpload();
		const upload = assert.rejects(store.upload(projectId, pending.id, stalled.source), status(409));
		await stalled.started;
		await store.close();
		await upload;
		const reopened = new WorkbenchStore(root);
		try {
			await reopened.init();
			assert.equal(reopened.getJob(projectId, pending.id).state, "cancelled");
			assert.deepEqual(await reopened.listDatasets(projectId), []);
		} finally {
			await reopened.close();
		}
		assert.deepEqual(await readdir(join(root, "staging")), []);
	});

	it("expires unused reservations and stalled uploads using deterministic timers", async (context) => {
		const { store, projectId } = await fixture(context);
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const reserved = await store.createImport(projectId, "unused.csv");
		context.mock.timers.tick(60_001);
		assert.equal((await waitJob(store, projectId, reserved.id)).state, "failed");
		const job = await store.createImport(projectId, "idle.csv");
		const stalled = stalledUpload();
		const upload = assert.rejects(store.upload(projectId, job.id, stalled.source), status(408));
		await stalled.started;
		context.mock.timers.tick(30_001);
		await upload;
		assert.equal(store.getJob(projectId, job.id).state, "failed");
		assert.ok(stalled.returned());
		context.mock.timers.reset();
	});

	it(
		"persists projects and datasets across restart while removing abandoned staging",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const dataset = await imported(store, projectId, "x\n1\n");
			await store.close();
			await mkdir(join(root, "staging", "abandoned"));
			await writeFile(join(root, "staging", "abandoned", "source.csv"), "private incomplete");
			const restarted = new WorkbenchStore(root);
			try {
				await restarted.init();
				assert.equal((await restarted.listProjects())[0].id, projectId);
				assert.deepEqual(await restarted.getDataset(projectId, dataset.id), dataset);
				assert.deepEqual((await restarted.preview(projectId, dataset.id, 0)).rows, [["1"]]);
				assert.deepEqual(await readdir(join(root, "staging")), []);
			} finally {
				await restarted.close();
			}
		},
	);

	it("rejects concurrent root owners before touching live staging", async (context) => {
		const { root, store, projectId } = await fixture(context);
		const job = await store.createImport(projectId, "active.csv");
		const stalled = stalledUpload();
		const upload = assert.rejects(store.upload(projectId, job.id, stalled.source), status(409));
		await stalled.started;
		const contender = new WorkbenchStore(root);
		await assert.rejects(contender.init(), status(409));
		await contender.close();
		assert.deepEqual(await readFile(join(root, "staging", job.id, "source.csv")), Buffer.from("x\n1\n"));
		await store.cancel(projectId, job.id);
		await upload;
	});

	it(
		"reprofiles atomically and retains previous metadata and preview on cancel or integrity failure",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const original = await imported(store, projectId, "x\n001\n-2\n");
			const job = await store.reprofile(projectId, original.id);
			assert.equal(job.kind, "reprofile");
			assert.deepEqual(await store.getDataset(projectId, original.id), original);
			assert.equal((await waitJob(store, projectId, job.id)).state, "completed");
			const refreshed = await store.getDataset(projectId, original.id);
			assert.deepEqual(refreshed.columns, original.columns);
			assert.equal(refreshed.profileVersion, PROFILE_VERSION);
			assert.notEqual(refreshed.profiledAt, original.profiledAt);
			assert.notEqual(refreshed.currentVersionId, original.currentVersionId);
			assert.equal(refreshed.sourceVersionId, original.sourceVersionId);
			assert.equal(refreshed.storageLocation, original.storageLocation);
			assert.deepEqual(refreshed.versions.slice(0, original.versions.length), original.versions);
			assert.equal(refreshed.versions.length, original.versions.length + 1);
			assert.deepEqual(await readFile(join(root, refreshed.storageLocation)), Buffer.from("x\n001\n-2\n"));
			assert.equal(refreshed.sha256, original.sha256);
			assert.equal(refreshed.createdAt, original.createdAt);
			const cancelled = await store.reprofile(projectId, original.id);
			await store.cancel(projectId, cancelled.id);
			assert.deepEqual(await store.getDataset(projectId, original.id), refreshed);
			await writeFile(join(root, original.storageLocation), "x\n999\n-2\n");
			const altered = await store.reprofile(projectId, original.id);
			const failed = await waitJob(store, projectId, altered.id);
			assert.equal(failed.state, "failed");
			assert.match(failed.error ?? "", /integrity|recorded size and SHA-256 hash/);
			assert.deepEqual(await store.getDataset(projectId, original.id), refreshed);
			assert.deepEqual((await store.preview(projectId, original.id, 0)).rows, [["001"], ["-2"]]);
		},
	);

	it("validates opaque identifiers, project names and filenames before filesystem use", async (context) => {
		const { store, projectId } = await fixture(context);
		for (const name of ["", " ", "x".repeat(121), "private\nname"])
			await assert.rejects(store.createProject(name), status(400));
		for (const name of [
			"",
			"../secret.csv",
			"folder\\secret.csv",
			"x".repeat(256),
			"\u0000.csv",
			"CON.csv",
			"private\u202efile.csv",
		]) {
			await assert.rejects(store.createImport(projectId, name), status(400));
		}
		for (const name of [".", "..", "data.json", "data.csv.exe"]) {
			await assert.rejects(store.createImport(projectId, name), status(415));
		}
		await assert.rejects(store.createImport(projectId, "data.csv", "application/parquet"), status(415));
		await assert.rejects(store.createImport(projectId, "data.parquet", "text/csv"), status(415));
		for (const id of ["../private", `${randomUUID()}\n`, "not-an-id"]) {
			await assert.rejects(store.listDatasets(id), status(400));
			await assert.rejects(store.getDataset(projectId, id), status(400));
			assert.throws(() => store.getJob(projectId, id), status(400));
		}
		await assert.rejects(store.listDatasets(randomUUID()), status(404));
	});
	it("preserves Parquet precision, native schema, nulls and empty schemas", { timeout: 120_000 }, async (context) => {
		const { root, store, projectId } = await fixture(context);
		const source = await parquetFixture(context);
		const dataset = await imported(store, projectId, source, "precision.PARQUET");
		assert.equal(dataset.format, "parquet");
		assert.equal(dataset.originalFilename, "precision.PARQUET");
		assert.equal(dataset.sha256, createHash("sha256").update(source).digest("hex"));
		assert.deepEqual(await readFile(join(root, dataset.storageLocation)), source);
		assert.deepEqual(dataset.parsing, { format: "parquet", emptyValues: "null", valueEncoding: "duckdb-text" });
		assert.deepEqual(dataset.schema, [
			{ index: 0, name: "exact_integer", sourceType: "BIGINT", basicType: "number" },
			{ index: 1, name: "unsigned_integer", sourceType: "UBIGINT", basicType: "number" },
			{ index: 2, name: "exact_decimal", sourceType: "DECIMAL(38,18)", basicType: "number" },
			{ index: 3, name: "day", sourceType: "DATE", basicType: "datetime" },
			{ index: 4, name: "instant", sourceType: "TIMESTAMP", basicType: "datetime" },
			{ index: 5, name: "flag", sourceType: "BOOLEAN", basicType: "boolean" },
			{ index: 6, name: "label", sourceType: "VARCHAR", basicType: "text" },
			{ index: 7, name: "items", sourceType: "INTEGER[]", basicType: "nested" },
		]);
		assert.equal(dataset.rowCount, 2);
		assert.equal(dataset.columnCount, 8);
		const first = await store.preview(projectId, dataset.id, 0, 1);
		assert.deepEqual(first, {
			offset: 0,
			limit: 1,
			total: 2,
			rows: [
				[
					"9007199254740993",
					"18446744073709551615",
					"12345678901234567890.123456789012345678",
					"2026-09-23",
					"2026-09-23 12:34:56.123456",
					"true",
					"",
					"[1, 2]",
				],
			],
		});
		assert.deepEqual((await store.preview(projectId, dataset.id, 1, 500)).rows, [
			Array.from({ length: 8 }, () => null),
		]);
		assert.ok(dataset.columns.slice(0, 3).every((column) => column.min === null && column.max === null));
		assert.ok(dataset.columns.slice(0, 3).every((column) => column.numericCount === 1));
		assert.ok(dataset.columns.every((column) => column.emptyCount === 1));
		assert.deepEqual(
			dataset.columns.map((column) => column.inferredType),
			["number", "number", "number", "text", "text", "boolean", "text", "text"],
		);
		const empty = await imported(store, projectId, await parquetFixture(context, true), "empty.parquet");
		assert.equal(empty.rowCount, 0);
		assert.deepEqual(empty.schema, dataset.schema);
		assert.deepEqual(await store.preview(projectId, empty.id, 0, 500), { offset: 0, limit: 500, total: 0, rows: [] });
	});

	it(
		"never publishes partial safe extrema for mixed safe and unsafe Parquet integers",
		{ timeout: 120_000 },
		async (context) => {
			const { store, projectId } = await fixture(context);
			const dataset = await imported(
				store,
				projectId,
				await mixedPrecisionFixture(context),
				"mixed-precision.parquet",
			);
			assert.ok(dataset.columns.every((column) => column.numericCount === 3));
			assert.ok(dataset.columns.slice(0, 2).every((column) => column.min === null && column.max === null));
			assert.equal(dataset.columns[2].min, -2);
			assert.equal(dataset.columns[2].max, 2);
			assert.deepEqual((await store.preview(projectId, dataset.id, 0)).rows, [
				["9007199254740993", "1", "1"],
				["1", "9007199254740993", "2"],
				["-2", "-2", "-2"],
			]);
		},
	);

	it(
		"rejects malformed, truncated and mismatched Parquet signatures without publication",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const valid = await parquetFixture(context);
			const badMagic = Buffer.from(valid);
			badMagic.write("NOPE", 0, "ascii");
			const badFooter = Buffer.from(valid);
			badFooter.writeUInt32LE(0xffffffff, badFooter.length - 8);
			const badFooterMagic = Buffer.from(valid);
			badFooterMagic.write("NOPE", badFooterMagic.length - 4, "ascii");
			const encrypted = Buffer.from(valid);
			encrypted.write("PARE", 0, "ascii");
			for (const source of [
				Buffer.from("x\nprivate cell\n"),
				badMagic,
				badFooter,
				badFooterMagic,
				encrypted,
				valid.subarray(0, valid.length - 1),
				Buffer.from("PAR1privatePAR1"),
			]) {
				const job = await store.createImport(projectId, "bad.parquet");
				await store.upload(projectId, job.id, bytes(source), "application/vnd.apache.parquet");
				const failed = await waitJob(store, projectId, job.id);
				assert.equal(failed.state, "failed");
				assert.ok(failed.error);
				assert.doesNotMatch(failed.error, /private cell/);
				assert.ok(!failed.error.includes(root));
				assert.equal(failed.datasetId, undefined);
				assert.deepEqual(await store.listDatasets(projectId), []);
				assert.deepEqual(await readdir(join(root, "staging")), []);
			}
			const csv = await store.createImport(projectId, "disguised.csv");
			await store.upload(projectId, csv.id, bytes(valid), "text/csv");
			assert.equal((await waitJob(store, projectId, csv.id)).state, "failed");
			assert.deepEqual(await readdir(join(root, "staging")), []);
			const blank = await store.createImport(projectId, "empty.parquet");
			await assert.rejects(store.upload(projectId, blank.id, bytes("")), status(400));
			assert.equal(store.getJob(projectId, blank.id).state, "failed");
			assert.deepEqual(await store.listDatasets(projectId), []);
		},
	);

	it(
		"recognizes duplicate hashes only within a project and isolates every resource operation",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const other = await store.createProject("Other project");
			const first = await imported(store, projectId, "x\n001\n");
			const duplicate = await imported(store, projectId, "x\n001\n");
			const separate = await imported(store, other.id, "x\n001\n");
			assert.equal(first.duplicateOf, undefined);
			assert.equal(duplicate.duplicateOf, first.id);
			assert.equal(separate.duplicateOf, undefined);
			assert.equal(separate.sha256, first.sha256);
			assert.notEqual(duplicate.id, first.id);
			assert.notEqual(duplicate.storageLocation, first.storageLocation);
			assert.notEqual(separate.storageLocation, first.storageLocation);
			assert.deepEqual(await readFile(join(root, separate.storageLocation)), Buffer.from("x\n001\n"));
			assert.deepEqual(
				(await store.listDatasets(other.id)).map((dataset) => dataset.id),
				[separate.id],
			);
			await assert.rejects(store.getDataset(other.id, first.id), status(404));
			await assert.rejects(store.preview(other.id, first.id, 0), status(404));
			await assert.rejects(store.reprofile(other.id, first.id), status(404));
			const reserved = await store.createImport(projectId, "private.csv");
			assert.throws(() => store.getJob(other.id, reserved.id), status(404));
			await assert.rejects(store.upload(other.id, reserved.id, bytes("x\nsecret\n")), status(404));
			await assert.rejects(store.cancel(other.id, reserved.id), status(404));
			await assert.rejects(store.retryImport(other.id, reserved.id), status(404));
			assert.equal(store.getJob(projectId, reserved.id).state, "uploading");
			assert.equal(store.getJob(projectId, reserved.id).bytesReceived, 0);
			await store.cancel(projectId, reserved.id);
		},
	);

	it(
		"retries failed and cancelled imports with new reservations requiring fresh bytes",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const failedReservation = await store.createImport(projectId, "retry.csv");
			await assert.rejects(store.upload(projectId, failedReservation.id, bytes("")), status(400));
			const failed = store.getJob(projectId, failedReservation.id);
			const retry = await store.retryImport(projectId, failed.id);
			assert.notEqual(retry.id, failed.id);
			assert.equal(retry.retryOf, failed.id);
			assert.equal(retry.name, failed.name);
			assert.equal(retry.format, failed.format);
			assert.equal(retry.state, "uploading");
			assert.equal(retry.bytesReceived, 0);
			assert.equal(retry.bytesProcessed, 0);
			assert.equal(retry.datasetId, undefined);
			assert.deepEqual(await store.listDatasets(projectId), []);
			await assert.rejects(store.retryImport(projectId, retry.id), status(409));
			await assert.rejects(store.upload(projectId, failed.id, bytes("x\nstale\n")), status(409));
			await store.upload(projectId, retry.id, bytes("x\nfresh\n"));
			const completed = await waitJob(store, projectId, retry.id);
			assert.equal(completed.state, "completed", completed.error);
			assert.ok(completed.datasetId);
			assert.deepEqual((await store.preview(projectId, completed.datasetId, 0)).rows, [["fresh"]]);
			assert.deepEqual(store.getJob(projectId, failed.id), failed);
			await assert.rejects(store.retryImport(projectId, completed.id), status(409));
			const cancelled = await store.createImport(projectId, "cancelled.csv");
			await store.cancel(projectId, cancelled.id);
			const retryCancelled = await store.retryImport(projectId, cancelled.id);
			assert.equal(retryCancelled.retryOf, cancelled.id);
			assert.notEqual(retryCancelled.id, cancelled.id);
			assert.equal(retryCancelled.bytesReceived, 0);
			await store.cancel(projectId, retryCancelled.id);
			assert.deepEqual(await readdir(join(root, "staging")), []);
			const original = (await store.listDatasets(projectId))[0];
			const reprofile = await store.reprofile(projectId, original.id);
			await store.cancel(projectId, reprofile.id);
			await assert.rejects(store.retryImport(projectId, reprofile.id), status(409));
		},
	);

	it(
		"persists terminal jobs and recovers interrupted SQLite jobs into retryable failures",
		{ timeout: 120_000 },
		async (context) => {
			const { root, store, projectId } = await fixture(context);
			const job = await store.createImport(projectId, "durable.csv");
			await store.upload(projectId, job.id, bytes("x\n1\n"));
			const completed = await waitJob(store, projectId, job.id);
			assert.equal(completed.state, "completed", completed.error);
			const bad = await store.createImport(projectId, "failed.csv");
			await assert.rejects(store.upload(projectId, bad.id, bytes("")), status(400));
			const failed = store.getJob(projectId, bad.id);
			const pending = await store.createImport(projectId, "interrupted.csv");
			const cancelled = await store.cancel(projectId, pending.id);
			await store.close();
			const interrupted: ImportJob[] = ["uploading", "processing"].map((state) => ({
				...pending,
				id: randomUUID(),
				state: state === "uploading" ? "uploading" : "processing",
				bytesReceived: 4,
			}));
			// Seed the exact durable states left by a process death, without killing the test runner.
			const database = new DatabaseSync(join(root, "workbench.sqlite"));
			try {
				const insert = database.prepare(
					"INSERT INTO jobs(id,project_id,state,created_at,metadata) VALUES (?,?,?,?,?)",
				);
				for (const saved of interrupted)
					insert.run(saved.id, projectId, saved.state, saved.createdAt, JSON.stringify(saved));
			} finally {
				database.close();
			}
			for (const saved of interrupted) {
				await mkdir(join(root, "staging", saved.id));
				await writeFile(join(root, "staging", saved.id, "source.csv"), "x\n1\n");
			}
			const reopened = new WorkbenchStore(root);
			try {
				await reopened.init();
				for (const terminal of [completed, failed, cancelled])
					assert.deepEqual(reopened.getJob(projectId, terminal.id), terminal);
				for (const saved of interrupted) {
					const recovered = reopened.getJob(projectId, saved.id);
					assert.equal(recovered.state, "failed");
					assert.match(recovered.error ?? "", /stopped|interrupted/i);
					assert.match(recovered.error ?? "", /retry/i);
					assert.equal(recovered.bytesReceived, saved.bytesReceived);
					const retry = await reopened.retryImport(projectId, saved.id);
					assert.equal(retry.retryOf, saved.id);
					assert.equal(retry.bytesReceived, 0);
					await reopened.cancel(projectId, retry.id);
				}
				assert.deepEqual(await readdir(join(root, "staging")), []);
			} finally {
				await reopened.close();
			}
		},
	);
});
