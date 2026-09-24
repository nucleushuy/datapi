import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantRun, AssistantSuggestion } from "../src/assistant-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type { Dataset, ImportJob, Project } from "../src/contracts.ts";
import { MetadataStore } from "../src/metadata.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";

const SOURCE = "category,value\na,1\na,3\nb,5\n";

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(10);
	}
	throw new Error("Assistant storage fixture job did not settle.");
}

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "workbench-assistant-storage-"));
	const state = { root, store: new WorkbenchStore(root) };
	context.after(async () => {
		await state.store.close();
		await rm(root, { recursive: true, force: true });
	});
	await state.store.init();
	const project = await state.store.createProject("Assistant fixtures");
	const job = await state.store.createImport(project.id, "assistant.csv");
	await state.store.upload(
		project.id,
		job.id,
		(async function* () {
			yield Buffer.from(SOURCE);
		})(),
	);
	const completed = await waitJob(state.store, project.id, job.id);
	assert.equal(completed.state, "completed", completed.error);
	assert.ok(completed.datasetId);
	const dataset = await state.store.getDataset(project.id, completed.datasetId);
	const version = dataset.versions.find((item) => item.id === dataset.currentVersionId);
	assert.ok(version);
	const artifactPath = join(root, version.storageLocation);
	const artifact = await readFile(artifactPath);
	return {
		state,
		project,
		dataset,
		artifactPath,
		artifact,
		artifactHash: createHash("sha256").update(artifact).digest("hex"),
	};
}

function status(expected: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === expected;
}

function runFor(project: Project, dataset: Dataset, artifactHash: string, index = 0): AssistantRun {
	const createdAt = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
	return {
		id: randomUUID(),
		projectId: project.id,
		datasetId: dataset.id,
		datasetVersionId: dataset.currentVersionId,
		provider: "test-provider",
		modelId: "test-model",
		createdAt,
		updatedAt: createdAt,
		state: "running",
		request: "Compare value by category",
		payloadHash: "a".repeat(64),
		context: {
			version: 1,
			project: { id: project.id, name: project.name, description: project.description },
			dataset: {
				id: dataset.id,
				name: dataset.name,
				versionId: dataset.currentVersionId,
				artifactHash,
				rowCount: dataset.rowCount,
				columnCount: dataset.columnCount,
			},
			schema: dataset.schema,
			selectedColumns: [0, 1],
			filters: [],
			evidence: [],
			artifacts: [],
			limitations: [],
			rowsIncluded: false,
		},
		summary: "",
		suggestions: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		latencyMs: 0,
		receivedCharacters: 0,
		error: null,
	};
}

function suggestionFor(dataset: Dataset, title = "Compare value by category"): AssistantSuggestion {
	return {
		id: "chart-1",
		category: "visualization",
		title,
		explanation: "Compare the aggregated values.",
		priority: "medium",
		confidence: 0.5,
		evidenceRefs: [],
		affectedColumns: [0, 1],
		proposedAction: {
			kind: "chart",
			spec: { ...defaultChartSpec(dataset.currentVersionId), x: 0, y: 1, aggregation: "sum" },
		},
		generatedCode: null,
		status: "proposed",
		basis: "hypothesis",
		chartId: null,
		error: null,
	};
}

async function accepted(
	store: WorkbenchStore,
	run: AssistantRun,
	suggestion: AssistantSuggestion,
): Promise<AssistantRun> {
	await store.putAssistantRun(run);
	run.state = "completed";
	run.summary = "A chart proposal requiring review.";
	run.suggestions = [suggestion];
	run.updatedAt = new Date().toISOString();
	await store.putAssistantRun(run);
	suggestion.status = "accepted";
	await store.putAssistantRun(run);
	return run;
}

test(
	"assistant history migrates schema three, persists scoped runs and recovers interrupted generation",
	{ timeout: 120_000 },
	async (context) => {
		const { state, project, dataset, artifactHash, artifactPath, artifact } = await fixture(context);
		assert.deepEqual(state.store.getProject(project.id), project);
		assert.throws(() => state.store.getProject("../private"), status(400));
		await state.store.close();
		const old = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			old.exec("DROP TABLE assistant_runs; PRAGMA user_version=3;");
		} finally {
			old.close();
		}
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const running = runFor(project, dataset, artifactHash);
		const completed = await accepted(state.store, runFor(project, dataset, artifactHash, 1), suggestionFor(dataset));
		await state.store.putAssistantRun(running);
		const other = await state.store.createProject("Other project");
		for (const operation of [
			() => state.store.assistantRuns(other.id, dataset.id),
			() => state.store.assistantRun(other.id, dataset.id, running.id),
			() => state.store.putAssistantRun({ ...running, projectId: other.id }),
			() =>
				state.store.applyAssistantChart(
					{ ...completed, projectId: other.id },
					"chart-1",
					completed.suggestions[0].title,
				),
			() => state.store.revertAssistantChart({ ...completed, projectId: other.id }, "chart-1"),
			() => state.store.assistantRun(project.id, dataset.id, randomUUID()),
		])
			await assert.rejects(operation(), status(404));
		await assert.rejects(state.store.assistantRun(project.id, dataset.id, "../run"), status(400));
		await assert.rejects(state.store.putAssistantRun({ ...running, id: "not-an-id" }), status(400));
		await assert.rejects(state.store.applyAssistantChart(completed, "../suggestion", "Chart"), status(400));
		await state.store.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const recovered = await state.store.assistantRun(project.id, dataset.id, running.id);
		assert.equal(recovered.state, "failed");
		assert.match(recovered.error ?? "", /server stopped/i);
		assert.deepEqual(recovered.suggestions, []);
		assert.deepEqual(await state.store.assistantRun(project.id, dataset.id, completed.id), completed);
		assert.deepEqual(
			(await state.store.assistantRuns(project.id, dataset.id)).map((run) => run.id),
			[completed.id, running.id],
		);
		assert.deepEqual(await state.store.getDataset(project.id, dataset.id), dataset);
		assert.deepEqual(await readFile(artifactPath), artifact);
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 4);
		} finally {
			database.close();
		}
	},
);

test(
	"assistant run history prunes oldest terminal runs but never drops running work",
	{ timeout: 120_000 },
	async (context) => {
		const { state, project, dataset, artifactHash } = await fixture(context);
		const runs: AssistantRun[] = [];
		for (let index = 0; index < 100; index++) {
			const run = runFor(project, dataset, artifactHash, index);
			await state.store.putAssistantRun(run);
			runs.push(run);
		}
		await assert.rejects(state.store.putAssistantRun(runFor(project, dataset, artifactHash, 100)), status(409));
		assert.equal((await state.store.assistantRuns(project.id, dataset.id)).length, 100);
		for (const index of [0, 1]) {
			runs[index].state = "completed";
			await state.store.putAssistantRun(runs[index]);
		}
		const newest = runFor(project, dataset, artifactHash, 101);
		await state.store.putAssistantRun(newest);
		await assert.rejects(state.store.assistantRun(project.id, dataset.id, runs[0].id), status(404));
		assert.equal((await state.store.assistantRun(project.id, dataset.id, runs[1].id)).state, "completed");
		assert.equal((await state.store.assistantRun(project.id, dataset.id, runs[2].id)).state, "running");
		assert.equal((await state.store.assistantRuns(project.id, dataset.id)).length, 100);
	},
);

test(
	"assistant apply and revert atomically own only new charts without changing data or lineage",
	{ timeout: 120_000 },
	async (context) => {
		const { state, project, dataset, artifactHash, artifactPath, artifact } = await fixture(context);
		const title = `Compare\n\u202e${"value ".repeat(30)}`;
		const run = await accepted(state.store, runFor(project, dataset, artifactHash), suggestionFor(dataset, title));
		const suggestion = run.suggestions[0];
		assert.equal(suggestion.proposedAction.kind, "chart");
		if (suggestion.proposedAction.kind !== "chart") throw new Error("Expected a chart proposal.");
		const original = await state.store.createChart(
			project.id,
			dataset.id,
			"Existing chart",
			suggestion.proposedAction.spec,
		);
		const forged = structuredClone(run);
		forged.suggestions[0].status = "applied";
		forged.suggestions[0].chartId = original.id;
		await assert.rejects(state.store.putAssistantRun(forged), status(409));
		const applied = await state.store.applyAssistantChart(run, suggestion.id, title);
		assert.equal(applied.suggestions[0].status, "applied");
		assert.notEqual(applied.suggestions[0].chartId, original.id);
		assert.equal(run.suggestions[0].status, "accepted");
		const charts = await state.store.listCharts(project.id, dataset.id);
		const saved = charts.find((chart) => chart.id === applied.suggestions[0].chartId);
		assert.ok(saved);
		assert.ok(saved.name.length <= 120);
		assert.doesNotMatch(saved.name, /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
		assert.deepEqual(saved.spec, suggestion.proposedAction.spec);
		await assert.rejects(state.store.applyAssistantChart(run, suggestion.id, title), status(409));
		const reverted = await state.store.revertAssistantChart(applied, suggestion.id);
		assert.equal(reverted.suggestions[0].status, "reverted");
		assert.equal(reverted.suggestions[0].chartId, saved.id);
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), [original]);
		await assert.rejects(state.store.revertAssistantChart(applied, suggestion.id), status(409));
		assert.deepEqual(await state.store.getDataset(project.id, dataset.id), dataset);
		assert.deepEqual(await readFile(artifactPath), artifact);
		assert.deepEqual(await readFile(join(state.root, dataset.storageLocation)), Buffer.from(SOURCE));
	},
);

test(
	"assistant chart transactions roll back both creation and deletion on metadata write errors",
	{ timeout: 120_000 },
	async (context) => {
		const { state, project, dataset, artifactHash } = await fixture(context);
		const run = await accepted(state.store, runFor(project, dataset, artifactHash), suggestionFor(dataset));
		const write = MetadataStore.prototype.putAssistantRun;
		let fail = true;
		context.mock.method(
			MetadataStore.prototype,
			"putAssistantRun",
			function (this: MetadataStore, value: AssistantRun) {
				if (fail && value.suggestions.some((item) => item.status === "applied" || item.status === "reverted"))
					throw new Error("Injected metadata write failure");
				write.call(this, value);
			},
		);
		await assert.rejects(
			state.store.applyAssistantChart(run, "chart-1", run.suggestions[0].title),
			/Injected metadata/,
		);
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), []);
		assert.deepEqual(await state.store.assistantRun(project.id, dataset.id, run.id), run);
		fail = false;
		const applied = await state.store.applyAssistantChart(run, "chart-1", run.suggestions[0].title);
		const before = await state.store.listCharts(project.id, dataset.id);
		fail = true;
		await assert.rejects(state.store.revertAssistantChart(applied, "chart-1"), /Injected metadata/);
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), before);
		assert.deepEqual(await state.store.assistantRun(project.id, dataset.id, run.id), applied);
		fail = false;
		await state.store.revertAssistantChart(applied, "chart-1");
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), []);
	},
);

test(
	"assistant application respects chart limits and rejects invalid or stale proposals",
	{ timeout: 120_000 },
	async (context) => {
		const { state, project, dataset, artifactHash } = await fixture(context);
		const run = await accepted(state.store, runFor(project, dataset, artifactHash), suggestionFor(dataset));
		const action = run.suggestions[0].proposedAction;
		if (action.kind !== "chart") throw new Error("Expected a chart proposal.");
		const charts = await Promise.all(
			Array.from({ length: 100 }, (_, index) =>
				state.store.createChart(project.id, dataset.id, `Chart ${index}`, action.spec),
			),
		);
		await assert.rejects(state.store.applyAssistantChart(run, "chart-1", run.suggestions[0].title), status(409));
		assert.deepEqual(await state.store.assistantRun(project.id, dataset.id, run.id), run);
		assert.equal((await state.store.listCharts(project.id, dataset.id)).length, 100);
		await state.store.deleteChart(project.id, dataset.id, charts[0].id);
		const invalid = suggestionFor(dataset);
		if (invalid.proposedAction.kind !== "chart") throw new Error("Expected a chart proposal.");
		invalid.proposedAction.spec.x = 999;
		const invalidRun = await accepted(state.store, runFor(project, dataset, artifactHash, 1), invalid);
		await assert.rejects(state.store.applyAssistantChart(invalidRun, "chart-1", invalid.title), status(400));
		assert.equal((await state.store.listCharts(project.id, dataset.id)).length, 99);
		const job = await state.store.reprofile(project.id, dataset.id);
		assert.equal((await waitJob(state.store, project.id, job.id)).state, "completed");
		await assert.rejects(state.store.applyAssistantChart(run, "chart-1", run.suggestions[0].title), status(409));
		await assert.rejects(state.store.putAssistantRun(runFor(project, dataset, artifactHash, 2)), status(409));
		run.suggestions[0].status = "rejected";
		await state.store.putAssistantRun(run);
		assert.equal((await state.store.assistantRun(project.id, dataset.id, run.id)).suggestions[0].status, "rejected");
	},
);

test(
	"assistant revert protects intentional chart edits, renames and removed chart ownership",
	{ timeout: 120_000 },
	async (context) => {
		const { state, project, dataset, artifactHash } = await fixture(context);
		const run = await accepted(state.store, runFor(project, dataset, artifactHash), suggestionFor(dataset));
		const applied = await state.store.applyAssistantChart(run, "chart-1", run.suggestions[0].title);
		const [chart] = await state.store.listCharts(project.id, dataset.id);
		const edited = await state.store.updateChart(project.id, dataset.id, chart.id, chart.name, {
			...chart.spec,
			sort: "descending",
		});
		await assert.rejects(state.store.revertAssistantChart(applied, "chart-1"), status(409));
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), [edited]);
		const renamed = await state.store.updateChart(project.id, dataset.id, chart.id, "User named chart", chart.spec);
		await assert.rejects(state.store.revertAssistantChart(applied, "chart-1"), status(409));
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), [renamed]);
		await state.store.deleteChart(project.id, dataset.id, chart.id);
		const replacement = await state.store.createChart(project.id, dataset.id, chart.name, chart.spec);
		await assert.rejects(state.store.revertAssistantChart(applied, "chart-1"), status(409));
		assert.deepEqual(await state.store.listCharts(project.id, dataset.id), [replacement]);
		assert.deepEqual(await state.store.assistantRun(project.id, dataset.id, run.id), applied);
	},
);
