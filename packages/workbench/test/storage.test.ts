import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Dataset, ImportJob } from "../src/contracts.ts";
import { MAX_COLUMNS, MAX_RECORD_BYTES, MAX_UPLOAD_BYTES, PAGE_SIZE, PROFILE_VERSION } from "../src/contracts.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";

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

async function waitJob(store: WorkbenchStore, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const job = store.getJob(id);
		if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") return job;
		await nextTurn();
	}
	throw new Error("Job did not reach a terminal state within 30 seconds.");
}

async function imported(store: WorkbenchStore, projectId: string, value: string | Uint8Array): Promise<Dataset> {
	const job = await store.createImport(projectId, "data.csv");
	const processing = await store.upload(job.id, bytes(value));
	assert.equal(processing.state, "processing");
	const completed = await waitJob(store, job.id);
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
	it("preserves BOM, quoted multiline strings and provenance with exact deterministic profiles", async (context) => {
		const { root, store, projectId } = await fixture(context);
		const source =
			'\uFEFFid,note,flag,missing,mixed\r\n001,"a,b\nline ""two""",true,,3\r\n-2,plain,false,,text\r\n, ,,,4e2\r\n';
		const dataset = await imported(store, projectId, source);
		assert.equal(dataset.byteSize, Buffer.byteLength(source));
		assert.equal(dataset.sha256, createHash("sha256").update(source).digest("hex"));
		assert.equal(dataset.profileVersion, PROFILE_VERSION);
		assert.deepEqual(dataset.parsing, {
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
		assert.deepEqual(
			await readFile(join(root, "projects", projectId, "datasets", dataset.id, "source.csv")),
			Buffer.from(source),
		);
		assert.deepEqual(await readdir(join(root, "staging")), []);
		dataset.columns[0].name = "mutated";
		assert.equal((await store.getDataset(projectId, dataset.id)).columns[0].name, "id");
	});

	it("seeks bounded preview pages at arbitrary offsets and handles header-only CSV", async (context) => {
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
		const empty = await imported(store, projectId, "id,value\n");
		assert.equal(empty.rowCount, 0);
		assert.ok(empty.columns.every((column) => column.inferredType === "empty" && column.emptyCount === 0));
		assert.deepEqual((await store.preview(projectId, empty.id, 0)).rows, []);
	});

	it("caps preview bytes independently of row count without skipping rows", async (context) => {
		const { store, projectId } = await fixture(context);
		const value = "\u0001".repeat(200_000);
		const dataset = await imported(
			store,
			projectId,
			`value\n${Array.from({ length: 10 }, () => `${value}\n`).join("")}`,
		);
		const page = await store.preview(projectId, dataset.id, 0);
		assert.ok(page.rows.length > 0 && page.rows.length < 10);
		assert.ok(Buffer.byteLength(JSON.stringify(page.rows)) < 8 * 1024 * 1024);
		const remaining = await store.preview(projectId, dataset.id, page.rows.length);
		assert.equal(page.rows.length + remaining.rows.length, 10);
		assert.ok([...page.rows, ...remaining.rows].every((row) => row[0] === value));
	});

	it("rejects malformed headers, column counts, quotes, UTF-8 and oversized records safely", async (context) => {
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
			await store.upload(job.id, bytes(value));
			const failed = await waitJob(store, job.id);
			assert.equal(failed.state, "failed");
			assert.ok(failed.error);
			assert.ok(!failed.error.includes("private"));
			assert.equal(failed.datasetId, undefined);
			assert.deepEqual(await store.listDatasets(projectId), []);
			assert.deepEqual(await readdir(join(root, "staging")), []);
		}
		const blank = await store.createImport(projectId, "empty.csv");
		await assert.rejects(store.upload(blank.id, bytes("")), status(400));
		assert.equal(store.getJob(blank.id).state, "failed");
	});

	it("enforces raw upload size before publication and cleans up rejected sources", async (context) => {
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
		await assert.rejects(store.upload(job.id, oversized()), status(413));
		assert.ok(finalized);
		assert.equal(store.getJob(job.id).state, "failed");
		assert.ok(store.getJob(job.id).bytesReceived <= MAX_UPLOAD_BYTES);
		assert.deepEqual(await store.listDatasets(projectId), []);
		assert.deepEqual(await readdir(join(root, "staging")), []);
	});

	it(
		"serializes reservations and duplicate uploads, snapshots progress and cancels a stalled source",
		{ timeout: 10_000 },
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
			const upload = assert.rejects(store.upload(job.id, stalled.source), status(409));
			await stalled.started;
			assert.equal(store.getJob(job.id).bytesReceived, 4);
			const snapshot = store.getJob(job.id);
			snapshot.state = "completed";
			assert.equal(store.getJob(job.id).state, "uploading");
			await assert.rejects(store.upload(job.id, bytes("x\n2\n")), status(409));
			assert.equal((await store.cancel(job.id)).state, "cancelled");
			await upload;
			assert.ok(stalled.returned());
			assert.deepEqual(await readdir(join(root, "staging")), []);
			assert.deepEqual(await store.listDatasets(projectId), []);
			const next = await store.createImport(projectId, "next.csv");
			await store.cancel(next.id);
		},
	);

	it("cancels processing and shutdown without publishing partial datasets", { timeout: 10_000 }, async (context) => {
		const { root, store, projectId } = await fixture(context);
		const job = await store.createImport(projectId, "processing.csv");
		await store.upload(job.id, bytes(`x\n${"1\n".repeat(100_000)}`));
		assert.equal((await store.cancel(job.id)).state, "cancelled");
		assert.deepEqual(await store.listDatasets(projectId), []);
		const pending = await store.createImport(projectId, "shutdown.csv");
		const stalled = stalledUpload();
		const upload = assert.rejects(store.upload(pending.id, stalled.source), status(409));
		await stalled.started;
		await store.close();
		await upload;
		assert.equal(store.getJob(pending.id).state, "cancelled");
		assert.deepEqual(await readdir(join(root, "staging")), []);
	});

	it("expires unused reservations and stalled uploads using deterministic timers", async (context) => {
		const { store, projectId } = await fixture(context);
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const reserved = await store.createImport(projectId, "unused.csv");
		context.mock.timers.tick(60_001);
		assert.equal((await waitJob(store, reserved.id)).state, "failed");
		const job = await store.createImport(projectId, "idle.csv");
		const stalled = stalledUpload();
		const upload = assert.rejects(store.upload(job.id, stalled.source), status(408));
		await stalled.started;
		context.mock.timers.tick(30_001);
		await upload;
		assert.equal(store.getJob(job.id).state, "failed");
		assert.ok(stalled.returned());
		context.mock.timers.reset();
	});

	it("persists projects and datasets across restart while removing abandoned staging", async (context) => {
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
	});

	it("rejects concurrent root owners before touching live staging", async (context) => {
		const { root, store, projectId } = await fixture(context);
		const job = await store.createImport(projectId, "active.csv");
		const stalled = stalledUpload();
		const upload = assert.rejects(store.upload(job.id, stalled.source), status(409));
		await stalled.started;
		const contender = new WorkbenchStore(root);
		await assert.rejects(contender.init(), status(409));
		await contender.close();
		assert.deepEqual(await readFile(join(root, "staging", job.id, "source.csv")), Buffer.from("x\n1\n"));
		await store.cancel(job.id);
		await upload;
	});

	it("reprofiles atomically and retains previous metadata and preview on cancel or integrity failure", async (context) => {
		const { root, store, projectId } = await fixture(context);
		const original = await imported(store, projectId, "x\n001\n-2\n");
		const directory = join(root, "projects", projectId, "datasets", original.id);
		const stale = {
			...original,
			profileVersion: 0,
			profiledAt: "2000-01-01T00:00:00.000Z",
			columns: original.columns.map((column) => ({ ...column, min: null })),
		};
		await writeFile(join(directory, "metadata.json"), JSON.stringify(stale));
		const job = await store.reprofile(projectId, original.id);
		assert.equal(job.kind, "reprofile");
		assert.deepEqual(await store.getDataset(projectId, original.id), stale);
		assert.equal((await waitJob(store, job.id)).state, "completed");
		const refreshed = await store.getDataset(projectId, original.id);
		assert.deepEqual(refreshed.columns, original.columns);
		assert.equal(refreshed.profileVersion, PROFILE_VERSION);
		assert.notEqual(refreshed.profiledAt, stale.profiledAt);
		assert.equal(refreshed.sha256, original.sha256);
		assert.equal(refreshed.createdAt, original.createdAt);
		const cancelled = await store.reprofile(projectId, original.id);
		await store.cancel(cancelled.id);
		assert.deepEqual(await store.getDataset(projectId, original.id), refreshed);
		await writeFile(join(directory, "source.csv"), "x\n999\n-2\n");
		const altered = await store.reprofile(projectId, original.id);
		const failed = await waitJob(store, altered.id);
		assert.equal(failed.state, "failed");
		assert.match(failed.error ?? "", /integrity/);
		assert.deepEqual(await store.getDataset(projectId, original.id), refreshed);
		assert.deepEqual((await store.preview(projectId, original.id, 0)).rows, [["001"], ["-2"]]);
	});

	it("validates opaque identifiers, project names and filenames before filesystem use", async (context) => {
		const { store, projectId } = await fixture(context);
		for (const name of ["", " ", "x".repeat(121), "private\nname"])
			await assert.rejects(store.createProject(name), status(400));
		for (const name of ["", "../secret.csv", "folder\\secret.csv", "x".repeat(256), "\u0000.csv", ".", ".."]) {
			await assert.rejects(store.createImport(projectId, name), status(400));
		}
		for (const id of ["../private", `${randomUUID()}\n`, "not-an-id"]) {
			await assert.rejects(store.listDatasets(id), status(400));
			await assert.rejects(store.getDataset(projectId, id), status(400));
			assert.throws(() => store.getJob(id), status(400));
		}
		await assert.rejects(store.listDatasets(randomUUID()), status(404));
	});
});
