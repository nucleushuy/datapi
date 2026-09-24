import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type { Dataset, ImportJob } from "../src/contracts.ts";
import { MetadataStore } from "../src/metadata.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";
import {
	TRANSFORM_DRAFT_TTL_MS,
	type TransformOperation,
	type TransformPreview,
	type TransformRecord,
	type TransformSpec,
} from "../src/transform-contracts.ts";

const SOURCE = "category,value,note\nA,1,first\nB,2,second\nA,3,third\n";

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	for (let attempt = 0; attempt < 12000; attempt++) {
		const job = store.getJob(projectId, id);
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(10);
	}
	throw new Error("Fixture job did not settle.");
}

async function imported(store: WorkbenchStore, projectId: string): Promise<Dataset> {
	const job = await store.createImport(projectId, "values.csv");
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

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "workbench-transform-"));
	const state = { root, store: new WorkbenchStore(root) };
	context.after(async () => {
		await state.store.close();
		await rm(root, { recursive: true, force: true });
	});
	await state.store.init();
	const project = await state.store.createProject("Transformations");
	const dataset = await imported(state.store, project.id);
	return { state, projectId: project.id, dataset };
}

function spec(
	dataset: Dataset,
	operation: TransformOperation = { kind: "filter", column: 0, operator: "eq", comparison: "text", value: "A" },
): TransformSpec {
	return { version: 1, datasetVersionId: dataset.currentVersionId, operation };
}

function status(expected: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === expected;
}

function artifact(root: string, dataset: Dataset): string {
	const version = dataset.versions.find((item) => item.id === dataset.currentVersionId);
	assert.ok(version);
	return join(root, version.storageLocation);
}

function facts(dataset: Dataset) {
	return {
		rowCount: dataset.rowCount,
		columnCount: dataset.columnCount,
		schema: dataset.schema,
		columns: dataset.columns,
		profileVersion: dataset.profileVersion,
		profiledAt: dataset.profiledAt,
	};
}

test(
	"preview replay, approved lineage, restart undo redo and branching preserve immutable version facts",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		const originalArtifact = await readFile(artifact(state.root, dataset));
		const first = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		const repeated = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		assert.deepEqual(repeated.impact, first.impact);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(first.impact.after, [
			["A", "1", "first"],
			["A", "3", "third"],
		]);
		assert.equal(first.impact.affectedRows, 1);
		assert.ok(first.impact.sql);
		assert.ok(first.impact.engineVersion);
		const applied = await state.store.applyTransform(projectId, dataset.id, { previewId: first.id, approved: true });
		assert.equal(applied.rowCount, 2);
		assert.equal(applied.versions.at(-1)?.parentVersionId, dataset.currentVersionId);
		assert.equal(applied.versions.at(-1)?.operation.kind, "transform");
		assert.deepEqual(applied.versions.slice(0, 2), dataset.versions);
		await assert.rejects(
			state.store.applyTransform(projectId, dataset.id, { previewId: repeated.id, approved: true }),
			status(409),
		);
		await assert.rejects(
			state.store.applyTransform(projectId, dataset.id, { previewId: first.id, approved: true }),
			status(409),
		);
		const changed = await state.store.previewTransform(
			projectId,
			dataset.id,
			spec(applied, { kind: "drop", columns: [2] }),
		);
		const dropped = await state.store.applyTransform(projectId, dataset.id, {
			previewId: changed.id,
			approved: true,
		});
		assert.equal(dropped.columnCount, 2);
		const droppedBytes = await readFile(artifact(state.root, dropped));
		await state.store.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dropped);
		const undone = await state.store.undoTransform(projectId, dataset.id, {
			expectedVersionId: dropped.currentVersionId,
		});
		assert.equal(undone.currentVersionId, applied.currentVersionId);
		assert.deepEqual(facts(undone), facts(applied));
		await state.store.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const redone = await state.store.redoTransform(projectId, dataset.id, {
			expectedVersionId: undone.currentVersionId,
		});
		assert.deepEqual(facts(redone), facts(dropped));
		await state.store.undoTransform(projectId, dataset.id, { expectedVersionId: redone.currentVersionId });
		const base = await state.store.undoTransform(projectId, dataset.id, {
			expectedVersionId: applied.currentVersionId,
		});
		assert.deepEqual(facts(base), facts(dataset));
		const branch = await state.store.previewTransform(
			projectId,
			dataset.id,
			spec(base, { kind: "rename", column: 0, name: "segment" }),
		);
		const branched = await state.store.applyTransform(projectId, dataset.id, {
			previewId: branch.id,
			approved: true,
		});
		assert.equal(branched.schema[0].name, "segment");
		assert.equal(branched.rowCount, 3);
		assert.equal(branched.versions.length, 5);
		await assert.rejects(
			state.store.redoTransform(projectId, dataset.id, { expectedVersionId: branched.currentVersionId }),
			status(409),
		);
		const history = await state.store.transformHistory(projectId, dataset.id);
		assert.equal(history.canUndo, true);
		assert.equal(history.canRedo, false);
		assert.equal(history.records.find((entry) => entry.id === first.id)?.outputVersionId, applied.currentVersionId);
		assert.ok(history.records.every((entry) => entry.actor === "local-user" && entry.completedAt));
		assert.deepEqual(await readFile(artifact(state.root, dataset)), originalArtifact);
		assert.deepEqual(await readFile(artifact(state.root, dropped)), droppedBytes);
		assert.deepEqual(await readFile(join(state.root, dataset.storageLocation)), Buffer.from(SOURCE));
		assert.deepEqual(await readdir(join(state.root, "transform-drafts")), []);
	},
);

test(
	"approval scope, exact bodies and synchronous shared admission reject concurrent and stale actions",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		const other = await state.store.createProject("Other scope");
		const sibling = await imported(state.store, projectId);
		const controller = new AbortController();
		const pending = state.store.previewTransform(projectId, dataset.id, spec(dataset), controller.signal);
		const cancelled = assert.rejects(pending, status(409));
		await assert.rejects(state.store.createImport(projectId, "blocked.csv"), status(409));
		await assert.rejects(state.store.previewTransform(projectId, dataset.id, spec(dataset)), status(409));
		await assert.rejects(state.store.preview(projectId, dataset.id, 0), status(409));
		await assert.rejects(state.store.profile(projectId, dataset.id), status(409));
		await assert.rejects(state.store.getProfile(projectId, dataset.id), status(409));
		controller.abort();
		await cancelled;
		assert.equal((await state.store.transformHistory(projectId, dataset.id)).records.at(-1)?.state, "cancelled");
		const preview = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		for (const value of [
			{ previewId: preview.id },
			{ previewId: preview.id, approved: false },
			{ previewId: preview.id, approved: true, spec: spec(dataset) },
		])
			await assert.rejects(state.store.applyTransform(projectId, dataset.id, value), status(400));
		for (const operation of [
			() => state.store.previewTransform(other.id, dataset.id, spec(dataset)),
			() => state.store.applyTransform(other.id, dataset.id, { previewId: preview.id, approved: true }),
			() => state.store.applyTransform(projectId, sibling.id, { previewId: preview.id, approved: true }),
			() => state.store.transformHistory(other.id, dataset.id),
			() => state.store.discardTransform(projectId, sibling.id, preview.id),
			() => state.store.undoTransform(other.id, dataset.id, { expectedVersionId: dataset.currentVersionId }),
			() => state.store.redoTransform(other.id, dataset.id, { expectedVersionId: dataset.currentVersionId }),
		])
			await assert.rejects(operation(), status(404));
		const applying = state.store.applyTransform(projectId, dataset.id, { previewId: preview.id, approved: true });
		await assert.rejects(
			state.store.applyTransform(projectId, dataset.id, { previewId: preview.id, approved: true }),
			status(409),
		);
		const applied = await applying;
		await assert.rejects(
			state.store.undoTransform(projectId, dataset.id, { expectedVersionId: dataset.currentVersionId }),
			status(409),
		);
		const undone = await state.store.undoTransform(projectId, dataset.id, {
			expectedVersionId: applied.currentVersionId,
		});
		const stale = await state.store.previewTransform(projectId, dataset.id, spec(undone));
		await state.store.redoTransform(projectId, dataset.id, { expectedVersionId: undone.currentVersionId });
		await state.store.undoTransform(projectId, dataset.id, { expectedVersionId: applied.currentVersionId });
		await assert.rejects(
			state.store.applyTransform(projectId, dataset.id, { previewId: stale.id, approved: true }),
			status(409),
		);
	},
);

test(
	"worker failure, corrupt inputs and outputs, and metadata publication rollback never change active dataset",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		await assert.rejects(
			state.store.previewTransform(
				projectId,
				dataset.id,
				spec(dataset, { kind: "cast", column: 0, type: "number", invalid: "error" }),
			),
			status(400),
		);
		assert.equal((await state.store.transformHistory(projectId, dataset.id)).records.at(-1)?.state, "failed");
		const corrupted = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		await writeFile(join(state.root, "transform-drafts", corrupted.id, "data.duckdb"), "corrupt");
		await assert.rejects(
			state.store.applyTransform(projectId, dataset.id, { previewId: corrupted.id, approved: true }),
			status(409),
		);
		const inputPreview = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		const original = await readFile(artifact(state.root, dataset));
		try {
			await writeFile(artifact(state.root, dataset), "corrupt");
			await assert.rejects(
				state.store.applyTransform(projectId, dataset.id, { previewId: inputPreview.id, approved: true }),
				status(409),
			);
		} finally {
			await writeFile(artifact(state.root, dataset), original);
		}
		const rollback = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			database.exec(
				"CREATE TRIGGER reject_transform_publication BEFORE UPDATE ON datasets BEGIN SELECT RAISE(ABORT, 'test publication failure'); END;",
			);
			await assert.rejects(
				state.store.applyTransform(projectId, dataset.id, { previewId: rollback.id, approved: true }),
				status(500),
			);
		} finally {
			database.exec("DROP TRIGGER reject_transform_publication;");
			database.close();
		}
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await readdir(join(state.root, "transform-drafts")), []);
		assert.deepEqual(await readdir(dirname(artifact(state.root, dataset))), ["data.duckdb"]);
		assert.deepEqual(await readdir(dirname(dirname(artifact(state.root, dataset)))), [dataset.currentVersionId]);
		assert.deepEqual(await readFile(join(state.root, dataset.storageLocation)), Buffer.from(SOURCE));
		const failed = (await state.store.transformHistory(projectId, dataset.id)).records.find(
			(entry) => entry.id === rollback.id,
		);
		assert.equal(failed?.state, "failed");
		assert.equal(failed?.outputVersionId, null);
		assert.ok(failed?.result);
	},
);

test(
	"durable drafts survive restart, expire deterministically, and recover interrupted publication without orphans",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		const preview = await state.store.previewTransform(projectId, dataset.id, spec(dataset));
		await state.store.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const applied = await state.store.applyTransform(projectId, dataset.id, {
			previewId: preview.id,
			approved: true,
		});
		const expiring = await state.store.previewTransform(projectId, dataset.id, spec(applied));
		context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		context.mock.timers.tick(TRANSFORM_DRAFT_TTL_MS + 1);
		await assert.rejects(
			state.store.applyTransform(projectId, dataset.id, { previewId: expiring.id, approved: true }),
			status(409),
		);
		assert.equal(
			(await state.store.transformHistory(projectId, dataset.id)).records.find((entry) => entry.id === expiring.id)
				?.state,
			"expired",
		);
		context.mock.timers.reset();
		await state.store.close();
		const metadata = new MetadataStore(join(state.root, "workbench.sqlite"));
		const interrupted: TransformRecord = {
			id: randomUUID(),
			projectId,
			datasetId: dataset.id,
			actor: "local-user",
			createdAt: new Date().toISOString(),
			completedAt: null,
			inputVersionId: applied.currentVersionId,
			outputVersionId: null,
			spec: spec(applied),
			state: "previewed",
			result: null,
			error: null,
		};
		metadata.putTransform(interrupted);
		metadata.close();
		await mkdir(join(state.root, "transform-drafts", interrupted.id));
		await writeFile(join(state.root, "transform-drafts", interrupted.id, "data.duckdb"), "interrupted");
		const orphan = randomUUID();
		const orphanPath = join(dirname(dirname(artifact(state.root, dataset))), orphan);
		await mkdir(orphanPath);
		await writeFile(join(orphanPath, "data.duckdb"), "published-before-metadata");
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), applied);
		const recovered = (await state.store.transformHistory(projectId, dataset.id)).records.find(
			(entry) => entry.id === interrupted.id,
		);
		assert.equal(recovered?.state, "failed");
		assert.match(recovered?.error ?? "", /server stopped/);
		assert.deepEqual(await readdir(join(state.root, "transform-drafts")), []);
		assert.ok(!(await readdir(dirname(orphanPath))).includes(orphan));
	},
);

test(
	"historical charts and profiles bind to version schema while transformed reprofile never rebuilds source",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		const profiling = await state.store.profile(projectId, dataset.id);
		assert.equal((await waitJob(state.store, projectId, profiling.id)).state, "completed");
		const originalProfile = await state.store.getProfile(projectId, dataset.id);
		assert.ok(originalProfile);
		const chartSpec = { ...defaultChartSpec(dataset.currentVersionId), x: 2 };
		const chart = await state.store.createChart(projectId, dataset.id, "Original note", chartSpec);
		const preview = await state.store.previewTransform(
			projectId,
			dataset.id,
			spec(dataset, { kind: "drop", columns: [2] }),
		);
		const applied = await state.store.applyTransform(projectId, dataset.id, {
			previewId: preview.id,
			approved: true,
		});
		assert.equal(await state.store.getProfile(projectId, dataset.id), null);
		assert.deepEqual(
			(await state.store.updateChart(projectId, dataset.id, chart.id, "Historical note", chartSpec)).spec,
			chartSpec,
		);
		await assert.rejects(
			state.store.createChart(projectId, dataset.id, "Invalid current", {
				...chartSpec,
				datasetVersionId: applied.currentVersionId,
			}),
			status(400),
		);
		const reprofile = await state.store.reprofile(projectId, dataset.id);
		assert.equal(reprofile.kind, "profile");
		assert.equal((await waitJob(state.store, projectId, reprofile.id)).state, "completed");
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), applied);
		assert.equal((await state.store.getProfile(projectId, dataset.id))?.columnCount, 2);
		const undone = await state.store.undoTransform(projectId, dataset.id, {
			expectedVersionId: applied.currentVersionId,
		});
		assert.deepEqual(await state.store.getProfile(projectId, dataset.id), originalProfile);
		assert.equal(
			(await state.store.chartPreview(projectId, dataset.id, chartSpec)).spec.datasetVersionId,
			dataset.currentVersionId,
		);
		await state.store.close();
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			const legacy = {
				...undone,
				versions: undone.versions
					.filter((version) => version.operation.kind !== "transform")
					.map(({ facts: _facts, ...version }) => version),
			};
			database.prepare("UPDATE datasets SET metadata=? WHERE id=?").run(JSON.stringify(legacy), dataset.id);
			database.exec("PRAGMA user_version=4;");
		} finally {
			database.close();
		}
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const upgraded = await state.store.getDataset(projectId, dataset.id);
		assert.deepEqual(facts(upgraded), facts(dataset));
		assert.equal(
			upgraded.versions.find((version) => version.id === upgraded.currentVersionId)?.facts?.rowCount,
			dataset.rowCount,
		);
		assert.deepEqual(await readFile(join(state.root, dataset.storageLocation)), Buffer.from(SOURCE));
	},
);

test(
	"retained draft ceiling and shutdown cancellation release analytical admission and preserve audit",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		const previews: TransformPreview[] = [];
		for (let index = 0; index < 4; index++)
			previews.push(await state.store.previewTransform(projectId, dataset.id, spec(dataset)));
		const retained = (await state.store.transformHistory(projectId, dataset.id)).records;
		assert.equal(retained.length, 4);
		for (const preview of previews) {
			const record = retained.find((entry) => entry.id === preview.id);
			assert.equal(record?.state, "previewed");
			assert.deepEqual(record?.result, preview.impact);
		}
		await assert.rejects(state.store.previewTransform(projectId, dataset.id, spec(dataset)), status(409));
		assert.deepEqual((await state.store.transformHistory(projectId, dataset.id)).records, retained);
		for (const preview of previews) await state.store.discardTransform(projectId, dataset.id, preview.id);
		const discarded = (await state.store.transformHistory(projectId, dataset.id)).records;
		assert.equal(discarded.length, 4);
		for (const preview of previews) {
			const record = discarded.find((entry) => entry.id === preview.id);
			assert.equal(record?.state, "cancelled");
			assert.equal(record?.outputVersionId, null);
			assert.deepEqual(record?.result, preview.impact);
			assert.ok(record?.completedAt);
			assert.equal(record?.error, "The user discarded this preview without applying it.");
		}
		const closing = state.store.previewTransform(projectId, dataset.id, spec(dataset));
		const rejected = assert.rejects(closing, status(409));
		await state.store.close();
		await rejected;
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		const records = (await state.store.transformHistory(projectId, dataset.id)).records;
		assert.equal(records.length, 5);
		for (const record of discarded)
			assert.deepEqual(
				records.find((entry) => entry.id === record.id),
				record,
			);
		const shutdown = records.filter((record) => !previews.some((preview) => preview.id === record.id));
		assert.equal(shutdown.length, 1);
		assert.equal(shutdown[0].state, "cancelled");
		assert.equal(shutdown[0].inputVersionId, dataset.currentVersionId);
		assert.equal(shutdown[0].outputVersionId, null);
		assert.equal(shutdown[0].result, null);
		assert.ok(shutdown[0].completedAt);
		assert.equal(shutdown[0].error, "Transformation was cancelled during shutdown.");
		assert.deepEqual(await readdir(join(state.root, "transform-drafts")), []);
		assert.equal((await state.store.preview(projectId, dataset.id, 0)).total, 3);
	},
);

test(
	"version and audit retention ceilings reject admission without deleting provenance",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset } = await fixture(context);
		const metadata = new MetadataStore(join(state.root, "workbench.sqlite"));
		try {
			const current = dataset.versions.find((version) => version.id === dataset.currentVersionId)!;
			const capped: Dataset = {
				...dataset,
				versions: [...dataset.versions, ...Array.from({ length: 98 }, () => ({ ...current, id: randomUUID() }))],
			};
			metadata.putDataset(capped);
			await assert.rejects(state.store.previewTransform(projectId, dataset.id, spec(capped)), status(409));
			await assert.rejects(state.store.reprofile(projectId, dataset.id), status(409));
			assert.equal((await state.store.transformHistory(projectId, dataset.id)).records.length, 0);
			metadata.putDataset(dataset);
			for (let index = 0; index < 100; index++) {
				metadata.putTransform({
					id: randomUUID(),
					projectId,
					datasetId: dataset.id,
					actor: "local-user",
					createdAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					inputVersionId: dataset.currentVersionId,
					outputVersionId: null,
					spec: spec(dataset),
					state: "cancelled",
					result: null,
					error: "The user discarded this preview.",
				});
			}
			await assert.rejects(state.store.previewTransform(projectId, dataset.id, spec(dataset)), status(409));
			assert.equal((await state.store.transformHistory(projectId, dataset.id)).records.length, 100);
			assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
			assert.deepEqual(await readdir(join(state.root, "transform-drafts")), []);
		} finally {
			metadata.close();
		}
	},
);
