import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, Dataset, ImportJob, Preview } from "../src/contracts.ts";
import { startWorkbench } from "../src/server.ts";
import { WorkbenchStore } from "../src/storage.ts";
import type { TransformHistory, TransformPreview, TransformSpec } from "../src/transform-contracts.ts";

test("transformation HTTP binds explicit approval to scoped preview and persists immutable undo redo", { timeout: 180_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-transform-http-"));
	const seed = new WorkbenchStore(root);
	await seed.init();
	const project = await seed.createProject("Transformation HTTP");
	const other = await seed.createProject("Other project");
	let original: Dataset;
	try {
		const job = await seed.createImport(project.id, "values.csv");
		await seed.upload(project.id, job.id, (async function* () { yield Buffer.from("category,value\nA,1\nB,2\nA,3\n"); })());
		let current: ImportJob = seed.getJob(project.id, job.id);
		for (let attempt = 0; current.state === "processing" && attempt < 1200; attempt++) {
			await delay(50);
			current = seed.getJob(project.id, job.id);
		}
		assert.equal(current.state, "completed", current.error);
		assert.ok(current.datasetId);
		original = await seed.getDataset(project.id, current.datasetId);
	} finally { await seed.close(); }
	let app = await startWorkbench({ dataDir: root, port: 0 });
	try {
		let bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json() as Bootstrap;
		let headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
		const base = `/api/projects/${project.id}/datasets/${original.id}`;
		const prefix = `${base}/transforms`;
		const foreign = `/api/projects/${other.id}/datasets/${original.id}/transforms`;
		const request = (path: string, method = "GET", body?: unknown) => fetch(`${app.url}${path}`, {
			method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const spec: TransformSpec = { version: 1, datasetVersionId: original.currentVersionId, operation: { kind: "filter", column: 0, operator: "eq", comparison: "text", value: "A" } };
		assert.equal((await fetch(`${app.url}${prefix}/history`)).status, 403);
		assert.equal((await fetch(`${app.url}${prefix}/preview`, { method: "POST", headers: { ...headers, Origin: "https://hostile.invalid" }, body: JSON.stringify({spec}) })).status, 403);
		assert.equal((await request(`${prefix}/preview`, "POST", { spec, sql: "DROP TABLE data" })).status, 400);
		assert.equal((await request(`${foreign}/preview`, "POST", { spec })).status, 404);
		const response = await request(`${prefix}/preview`, "POST", { spec });
		assert.equal(response.status, 201, await response.clone().text());
		const preview = await response.json() as TransformPreview;
		assert.equal(preview.impact.inputRows, 3);
		assert.equal(preview.impact.rowCount, 2);
		assert.equal(preview.impact.affectedRows, 1);
		assert.deepEqual(preview.impact.after, [["A", "1"], ["A", "3"]]);
		assert.equal((await (await request(base)).json() as Dataset).currentVersionId, original.currentVersionId);
		for (const [path, method, body] of [
			[`${foreign}/history`, "GET", undefined],
			[`${foreign}/apply`, "POST", { previewId: preview.id, approved: true }],
			[`${foreign}/undo`, "POST", { expectedVersionId: original.currentVersionId }],
			[`${foreign}/redo`, "POST", { expectedVersionId: original.currentVersionId }],
			[`${foreign}/previews/${preview.id}`, "DELETE", undefined],
		] as const) assert.equal((await request(path, method, body)).status, 404, path);
		for (const body of [{previewId: preview.id}, {previewId: preview.id, approved: false}, {previewId: preview.id, approved: true, spec}]) {
			assert.equal((await request(`${prefix}/apply`, "POST", body)).status, 400);
		}
		const appliedResponse = await request(`${prefix}/apply`, "POST", { previewId: preview.id, approved: true });
		assert.equal(appliedResponse.status, 200, await appliedResponse.clone().text());
		const applied = await appliedResponse.json() as Dataset;
		assert.notEqual(applied.currentVersionId, original.currentVersionId);
		assert.equal(applied.versions.find(v => v.id === applied.currentVersionId)?.parentVersionId, original.currentVersionId);
		assert.equal(applied.sha256, original.sha256);
		assert.equal(applied.storageLocation, original.storageLocation);
		assert.equal(applied.rowCount, 2);
		assert.deepEqual((await (await request(`${base}/preview`)).json() as Preview).rows, [["A", "1"], ["A", "3"]]);
		assert.ok((await request(`${prefix}/apply`, "POST", {previewId: preview.id, approved: true})).status >= 400);
		assert.equal((await request(`${prefix}/preview`, "POST", {spec})).status, 409);
		assert.equal((await request(`${prefix}/undo`, "POST", { expectedVersionId: original.currentVersionId })).status, 409);
		await app.close();
		app = await startWorkbench({dataDir: root, port: 0});
		bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json() as Bootstrap;
		headers = {"X-Workbench-Token": bootstrap.token, "Content-Type": "application/json"};
		const history = await (await request(`${prefix}/history`)).json() as TransformHistory;
		assert.equal(history.canUndo, true);
		assert.equal(history.records.find(r => r.id === preview.id)?.state, "applied");
		const undoResponse = await request(`${prefix}/undo`, "POST", {expectedVersionId: applied.currentVersionId});
		assert.equal(undoResponse.status, 200, await undoResponse.clone().text());
		const undone = await undoResponse.json() as Dataset;
		assert.equal(undone.currentVersionId, original.currentVersionId);
		assert.equal(undone.rowCount, 3);
		assert.deepEqual(undone.schema, original.schema);
		assert.deepEqual((await (await request(`${base}/preview`)).json() as Preview).rows, [["A", "1"], ["B", "2"], ["A", "3"]]);
		const redoResponse = await request(`${prefix}/redo`, "POST", {expectedVersionId: undone.currentVersionId});
		assert.equal(redoResponse.status, 200, await redoResponse.clone().text());
		assert.equal((await redoResponse.json() as Dataset).currentVersionId, applied.currentVersionId);
		const discardedResponse = await request(`${prefix}/preview`, "POST", {spec: {...spec, datasetVersionId: applied.currentVersionId}});
		assert.equal(discardedResponse.status, 201, await discardedResponse.clone().text());
		const discarded = await discardedResponse.json() as TransformPreview;
		assert.equal((await request(`${prefix}/previews/${discarded.id}`, "DELETE")).status, 200);
		assert.ok((await request(`${prefix}/apply`, "POST", {previewId: discarded.id, approved:true})).status >= 400);
	} finally {
		await app.close();
		await rm(root, {recursive:true, force:true});
	}
});
