import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChartRecord, ChartResult, ChartSpec } from "../src/chart-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type { Bootstrap, Dataset, ImportJob } from "../src/contracts.ts";
import { startWorkbench, type WorkbenchApplication } from "../src/server.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";

const SOURCE = "category,value,private_note\na,1,private-first\na,3,private-second\nb,5,private-third\n";

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "workbench-chart-"));
	const state = { root, store: new WorkbenchStore(root) };
	context.after(async () => {
		await state.store.close();
		await rm(root, { recursive: true, force: true });
	});
	await state.store.init();
	const project = await state.store.createProject("Chart fixtures");
	return { state, projectId: project.id };
}

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(10);
	}
	throw new Error("Chart fixture job did not settle.");
}

async function imported(store: WorkbenchStore, projectId: string): Promise<Dataset> {
	const job = await store.createImport(projectId, "chart.csv");
	await store.upload(
		projectId,
		job.id,
		(async function* () {
			yield Buffer.from(SOURCE);
		})(),
	);
	const completed = await waitJob(store, projectId, job.id);
	assert.equal(completed.state, "completed", completed.error);
	assert.ok(completed.datasetId);
	return store.getDataset(projectId, completed.datasetId);
}

async function profiled(store: WorkbenchStore, projectId: string, datasetId: string): Promise<void> {
	const job = await store.profile(projectId, datasetId);
	const completed = await waitJob(store, projectId, job.id);
	assert.equal(completed.state, "completed", completed.error);
}

function status(expected: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === expected;
}

function chartSpec(dataset: Dataset): ChartSpec {
	return { ...defaultChartSpec(dataset.currentVersionId), x: 0, y: 1, aggregation: "sum" };
}

function artifact(root: string, dataset: Dataset): string {
	const current = dataset.versions.find((version) => version.id === dataset.currentVersionId);
	assert.ok(current);
	return join(root, current.storageLocation);
}

test(
	"saved charts duplicate, rename, delete, persist and enforce dataset ownership",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const dataset = await imported(state.store, projectId);
		const other = await state.store.createProject("Other owner");
		const beforeArtifact = await readFile(artifact(state.root, dataset));
		const spec = chartSpec(dataset);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
		const saved = await state.store.createChart(projectId, dataset.id, "  Original  ", spec);
		assert.equal(saved.name, "Original");
		assert.equal(saved.projectId, projectId);
		assert.equal(saved.datasetId, dataset.id);
		assert.deepEqual(saved.spec, spec);
		const duplicate = await state.store.createChart(projectId, dataset.id, "Duplicate", saved.spec);
		assert.notEqual(duplicate.id, saved.id);
		const renamed = await state.store.updateChart(projectId, dataset.id, saved.id, "Renamed", saved.spec);
		assert.equal(renamed.id, saved.id);
		assert.equal(renamed.createdAt, saved.createdAt);
		assert.deepEqual(renamed.spec, saved.spec);
		assert.equal(renamed.name, "Renamed");
		for (const operation of [
			() => state.store.listCharts(other.id, dataset.id),
			() => state.store.createChart(other.id, dataset.id, "Leak", spec),
			() => state.store.updateChart(other.id, dataset.id, saved.id, "Leak", spec),
			() => state.store.deleteChart(other.id, dataset.id, saved.id),
			() => state.store.chartPreview(other.id, dataset.id, spec),
			() => state.store.updateChart(projectId, dataset.id, randomUUID(), "Missing", spec),
			() => state.store.deleteChart(projectId, dataset.id, randomUUID()),
		])
			await assert.rejects(operation(), status(404));
		for (const name of ["", " ", "x".repeat(121), "unsafe\u0000name", "unsafe\u202ename"])
			await assert.rejects(state.store.createChart(projectId, dataset.id, name, spec), status(400));
		for (const invalid of [
			{ ...spec, sql: "SELECT private_note FROM data" },
			{ ...spec, categoryLimit: 31 },
			{ ...spec, x: 999 },
		])
			await assert.rejects(state.store.createChart(projectId, dataset.id, "Invalid", invalid), status(400));
		await assert.rejects(
			state.store.createChart(projectId, dataset.id, "Wrong version", { ...spec, datasetVersionId: randomUUID() }),
			status(409),
		);
		assert.deepEqual(await state.store.deleteChart(projectId, dataset.id, duplicate.id), { deleted: true });
		await assert.rejects(state.store.deleteChart(projectId, dataset.id, duplicate.id), status(404));
		await state.store.close();
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 5);
			assert.equal(
				database
					.prepare("SELECT dataset_version_id FROM charts WHERE project_id=? AND dataset_id=? AND id=?")
					.get(projectId, dataset.id, saved.id)?.dataset_version_id,
				dataset.currentVersionId,
			);
		} finally {
			database.close();
		}
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), [renamed]);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await readFile(artifact(state.root, dataset)), beforeArtifact);
		assert.deepEqual(await readFile(join(state.root, dataset.storageLocation)), Buffer.from(SOURCE));
	},
);

test(
	"chart limits are per dataset and stale configurations retain version identity",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const dataset = await imported(state.store, projectId);
		const otherDataset = await imported(state.store, projectId);
		const spec = chartSpec(dataset);
		const saved = await Promise.all(
			Array.from({ length: 100 }, (_, index) =>
				state.store.createChart(projectId, dataset.id, `Chart ${index}`, spec),
			),
		);
		assert.equal((await state.store.listCharts(projectId, dataset.id)).length, 100);
		await assert.rejects(state.store.createChart(projectId, dataset.id, "Over limit", spec), status(409));
		const otherChart = await state.store.createChart(
			projectId,
			otherDataset.id,
			"Independent",
			chartSpec(otherDataset),
		);
		await assert.rejects(
			state.store.updateChart(projectId, dataset.id, otherChart.id, "Wrong dataset", spec),
			status(404),
		);
		await assert.rejects(state.store.deleteChart(projectId, dataset.id, otherChart.id), status(404));
		await state.store.updateChart(projectId, dataset.id, saved[0].id, "Rename at limit", spec);
		await state.store.deleteChart(projectId, dataset.id, saved[99].id);
		await state.store.createChart(projectId, dataset.id, "Replacement", spec);
		assert.equal((await state.store.listCharts(projectId, dataset.id)).length, 100);
		const reprofile = await state.store.reprofile(projectId, dataset.id);
		assert.equal((await waitJob(state.store, projectId, reprofile.id)).state, "completed");
		const current = await state.store.getDataset(projectId, dataset.id);
		assert.notEqual(current.currentVersionId, dataset.currentVersionId);
		assert.ok(
			(await state.store.listCharts(projectId, dataset.id)).every(
				(chart) => chart.spec.datasetVersionId === dataset.currentVersionId,
			),
		);
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, chartSpec(current)), status(409));
		const renamed = await state.store.updateChart(projectId, dataset.id, saved[0].id, "Historical chart", spec);
		assert.equal(renamed.spec.datasetVersionId, dataset.currentVersionId);
		await state.store.deleteChart(projectId, dataset.id, saved[98].id);
		const copied = await state.store.createChart(projectId, dataset.id, "Historical copy", renamed.spec);
		assert.equal(copied.spec.datasetVersionId, dataset.currentVersionId);
		await profiled(state.store, projectId, dataset.id);
		assert.equal(
			(await state.store.chartPreview(projectId, dataset.id, chartSpec(current))).spec.datasetVersionId,
			current.currentVersionId,
		);
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
	},
);

test(
	"real chart previews require verified profiles, aggregate bounded rows and preserve artifacts",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const dataset = await imported(state.store, projectId);
		const spec = chartSpec(dataset);
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		await profiled(state.store, projectId, dataset.id);
		const before = await readFile(artifact(state.root, dataset));
		const result = await state.store.chartPreview(projectId, dataset.id, spec);
		assert.deepEqual(result.spec, spec);
		assert.equal(result.datasetVersionHash, createHash("sha256").update(before).digest("hex"));
		assert.equal(result.populationRows, 3);
		assert.equal(result.sampleSize, 3);
		assert.equal(result.filteredRows, 3);
		assert.deepEqual(
			result.marks.map((mark) => [mark.x, mark.value, mark.rowIds]),
			[
				['"a"', 4, [0, 1]],
				['"b"', 5, [2]],
			],
		);
		assert.deepEqual(
			result.table.columns.map((column) => column.index),
			[0, 1],
		);
		assert.doesNotMatch(JSON.stringify(result), /private-first|private-second|private-third/);
		const filteredSpec: ChartSpec = { ...spec, filters: [{ column: 0, op: "eq", value: "a" }] };
		const filtered = await state.store.chartPreview(projectId, dataset.id, filteredSpec);
		assert.equal(filtered.filteredRows, 2);
		assert.deepEqual(
			filtered.marks.map((mark) => mark.rowIds),
			[[0, 1]],
		);
		assert.deepEqual(
			filtered.table.rows.map((row) => row.rowId),
			[0, 1],
		);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
		assert.deepEqual(await readFile(artifact(state.root, dataset)), before);
		assert.deepEqual(await readFile(join(state.root, dataset.storageLocation)), Buffer.from(SOURCE));
		const corrupt = Buffer.from(before);
		corrupt.fill(0, 0, 16);
		try {
			await writeFile(artifact(state.root, dataset), corrupt);
			await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		} finally {
			await writeFile(artifact(state.root, dataset), before);
		}
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		assert.ok(await state.store.getProfile(projectId, dataset.id));
		assert.equal((await state.store.preview(projectId, dataset.id, 0)).rows.length, 3);
	},
);

test(
	"chart admission, cancellation and shutdown release resources without creating import jobs",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const dataset = await imported(state.store, projectId);
		await profiled(state.store, projectId, dataset.id);
		const spec = chartSpec(dataset);
		const preaborted = new AbortController();
		preaborted.abort();
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec, preaborted.signal), status(409));
		const controller = new AbortController();
		const pending = state.store.chartPreview(projectId, dataset.id, spec, controller.signal);
		const rejected = assert.rejects(pending, status(409));
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		await assert.rejects(state.store.preview(projectId, dataset.id, 0), status(409));
		await assert.rejects(state.store.profile(projectId, dataset.id), status(409));
		await assert.rejects(state.store.getProfile(projectId, dataset.id), status(409));
		await assert.rejects(state.store.createImport(projectId, "blocked.csv"), status(409));
		const deadline = Date.now() + 5000;
		while ((await readdir(join(state.root, "staging"))).length === 0 && Date.now() < deadline) await delay(1);
		assert.equal((await readdir(join(state.root, "staging"))).length, 1);
		controller.abort();
		await rejected;
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		const read = state.store.getProfile(projectId, dataset.id);
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		assert.ok(await read);
		const preview = state.store.preview(projectId, dataset.id, 0);
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		assert.equal((await preview).rows.length, 3);
		const reservation = await state.store.createImport(projectId, "reserved.csv");
		await assert.rejects(state.store.chartPreview(projectId, dataset.id, spec), status(409));
		assert.ok(await state.store.getProfile(projectId, dataset.id));
		await state.store.cancel(projectId, reservation.id);
		const closingPreview = state.store.chartPreview(projectId, dataset.id, spec);
		const closingRejected = assert.rejects(closingPreview, status(409));
		await Promise.resolve();
		await state.store.close();
		await closingRejected;
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		assert.equal((await state.store.chartPreview(projectId, dataset.id, spec)).sampleSize, 3);
		await state.store.close();
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			assert.equal(
				database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE json_extract(metadata,'$.kind')='chart'").get()
					?.count,
				0,
			);
		} finally {
			database.close();
		}
	},
);

test(
	"metadata version two migrates to chart storage without changing existing datasets",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const dataset = await imported(state.store, projectId);
		await state.store.close();
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			database.exec("DROP TABLE charts; PRAGMA user_version=2;");
		} finally {
			database.close();
		}
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
		const saved = await state.store.createChart(projectId, dataset.id, "Migrated", chartSpec(dataset));
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), [saved]);
	},
);

test(
	"chart HTTP CRUD and previews enforce body, scope and disconnected request boundaries",
	{ timeout: 120_000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "workbench-chart-http-"));
		const seed = new WorkbenchStore(root);
		let app: WorkbenchApplication | undefined;
		context.after(async () => {
			await app?.close();
			await seed.close();
			await rm(root, { recursive: true, force: true });
		});
		await seed.init();
		const project = await seed.createProject("HTTP charts");
		const other = await seed.createProject("Other owner");
		const dataset = await imported(seed, project.id);
		await profiled(seed, project.id, dataset.id);
		await seed.close();
		app = await startWorkbench({ dataDir: root, port: 0 });
		try {
			const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
			const headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
			const base = `${app.url}/api/projects/${project.id}/datasets/${dataset.id}`;
			const spec = chartSpec(dataset);
			assert.equal((await fetch(`${base}/charts`)).status, 403);
			for (const [suffix, method, body] of [
				["charts", "GET", undefined],
				["charts", "POST", JSON.stringify({ name: "Leak", spec })],
				["chart-preview", "POST", JSON.stringify({ spec })],
			] as const)
				assert.equal(
					(
						await fetch(`${app.url}/api/projects/${other.id}/datasets/${dataset.id}/${suffix}`, {
							method,
							headers,
							body,
						})
					).status,
					404,
				);
			assert.equal((await fetch(`${base}/charts`, { method: "POST", headers, body: "{" })).status, 400);
			assert.equal(
				(
					await fetch(`${base}/charts`, {
						method: "POST",
						headers,
						body: JSON.stringify({ name: "x".repeat(32_769), spec }),
					})
				).status,
				413,
			);
			assert.equal(
				(
					await fetch(`${base}/chart-preview`, {
						method: "POST",
						headers,
						body: JSON.stringify({ spec, artifactPath: "C:/private" }),
					})
				).status,
				400,
			);
			const created = await fetch(`${base}/charts`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "HTTP chart", spec }),
			});
			assert.equal(created.status, 201);
			const saved = (await created.json()) as ChartRecord;
			const duplicateResponse = await fetch(`${base}/charts`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "Copy", spec: saved.spec }),
			});
			assert.equal(duplicateResponse.status, 201);
			const duplicate = (await duplicateResponse.json()) as ChartRecord;
			assert.notEqual(saved.id, duplicate.id);
			const renamed = await fetch(`${base}/charts/${saved.id}`, {
				method: "PUT",
				headers,
				body: JSON.stringify({ name: "Renamed", spec }),
			});
			assert.equal(renamed.status, 200);
			assert.equal(((await renamed.json()) as ChartRecord).name, "Renamed");
			assert.equal(
				(
					await fetch(`${base}/charts/${randomUUID()}`, {
						method: "PUT",
						headers,
						body: JSON.stringify({ name: "Unknown", spec }),
					})
				).status,
				404,
			);
			assert.equal(((await (await fetch(`${base}/charts`, { headers })).json()) as ChartRecord[]).length, 2);
			const response = await fetch(`${base}/chart-preview`, {
				method: "POST",
				headers,
				body: JSON.stringify({ spec }),
			});
			assert.equal(response.status, 200);
			assert.equal(((await response.json()) as ChartResult).sampleSize, 3);
			const disconnected = httpRequest(`${base}/chart-preview`, { method: "POST", headers });
			disconnected.on("error", () => {});
			disconnected.on("response", (value) => value.resume());
			disconnected.end(JSON.stringify({ spec }));
			const deadline = Date.now() + 5000;
			while ((await readdir(join(root, "staging"))).length === 0 && Date.now() < deadline) await delay(1);
			assert.equal((await readdir(join(root, "staging"))).length, 1);
			disconnected.destroy();
			while ((await readdir(join(root, "staging"))).length !== 0 && Date.now() < deadline) await delay(10);
			assert.deepEqual(await readdir(join(root, "staging")), []);
			const afterDisconnect = await fetch(`${base}/chart-preview`, {
				method: "POST",
				headers,
				body: JSON.stringify({ spec }),
			});
			assert.equal(afterDisconnect.status, 200);
			assert.equal(((await afterDisconnect.json()) as ChartResult).sampleSize, 3);
			const deleted = await fetch(`${base}/charts/${duplicate.id}`, { method: "DELETE", headers });
			assert.equal(deleted.status, 200);
			assert.deepEqual(await deleted.json(), { deleted: true });
			assert.equal((await fetch(`${base}/charts/${duplicate.id}`, { method: "DELETE", headers })).status, 404);
			assert.equal((await fetch(`${base}/profile`, { headers })).status, 200);
			assert.equal((await fetch(`${base}/preview?offset=0`, { headers })).status, 200);
		} finally {
			await app.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
