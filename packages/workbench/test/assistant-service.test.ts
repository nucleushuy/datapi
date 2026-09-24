import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import {
	ASSISTANT_TIMEOUT_MS,
	type AssistantContext,
	type AssistantDriver,
	type AssistantModels,
	type AssistantPayload,
	type AssistantProgress,
	type AssistantRun,
	type AssistantSelection,
	type AssistantUsage,
} from "../src/assistant-contracts.ts";
import { AssistantService } from "../src/assistant-service.ts";
import type { ChartRecord, ChartSpec } from "../src/chart-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type { Dataset, ImportJob, Project } from "../src/contracts.ts";
import { computeDatasetProfile } from "../src/dataset-profiler.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";

const USAGE: AssistantUsage = { input: 20, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 32 };
const SOURCE = "category,value,note\na,1,private-cell-never-send\na,3,private-second\nb,5,private-third\n";
type ServiceStore = ConstructorParameters<typeof AssistantService>[0];
type GenerationInput = Parameters<AssistantDriver["generate"]>[0];
type GenerationResult = Awaited<ReturnType<AssistantDriver["generate"]>>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function output(payload: AssistantPayload, charts = 1): string {
	const { context } = JSON.parse(payload.user) as { context: AssistantContext };
	return JSON.stringify({
		summary: "Aggregate comparison is a hypothesis requiring local validation.",
		suggestions: Array.from({ length: charts }, (_, index) => ({
			id: `chart-${index}`,
			category: "visualization",
			title: `Compare category totals ${index}`,
			explanation: "A local aggregate chart can compare the disclosed numeric values.",
			priority: "medium",
			confidence: 0.5,
			evidenceRefs: ["dataset.rows"],
			affectedColumns: [0, 1],
			generatedCode: null,
			proposedAction: {
				kind: "chart",
				spec: { ...defaultChartSpec(context.dataset.versionId), type: "bar", x: 0, y: 1, aggregation: "sum" },
			},
		})),
	});
}

class LocalDriver implements AssistantDriver {
	configured = true;
	calls: { input: GenerationInput; onProgress: (value: AssistantProgress) => void; signal: AbortSignal }[] = [];
	handle: (
		input: GenerationInput,
		progress: (value: AssistantProgress) => void,
		signal: AbortSignal,
	) => Promise<GenerationResult> = async (input) => ({ text: output(input.payload), usage: USAGE });
	async models(): Promise<AssistantModels> {
		return {
			models: [
				{
					provider: "local-test",
					id: "fixture-model",
					name: "Deterministic test driver",
					configured: this.configured,
					contextWindow: 128_000,
				},
			],
			guidance: "Tests only.",
		};
	}
	async generate(
		input: GenerationInput,
		onProgress: (value: AssistantProgress) => void,
		signal: AbortSignal,
	): Promise<GenerationResult> {
		this.calls.push({ input: structuredClone(input), onProgress, signal });
		return this.handle(input, onProgress, signal);
	}
}

function status(expected: number) {
	return (error: unknown) => error instanceof WorkbenchError && error.status === expected;
}

function selection(dataset: Dataset, request = "Compare category totals"): AssistantSelection {
	return {
		datasetVersionId: dataset.currentVersionId,
		selectedColumns: [0, 1],
		filters: [],
		request,
		provider: "local-test",
		modelId: "fixture-model",
	};
}

function memoryFixture(context: TestContext) {
	const now = new Date().toISOString();
	const project: Project = {
		id: randomUUID(),
		name: "Local fixture",
		description: "",
		ownerId: null,
		createdAt: now,
		updatedAt: now,
		settings: { previewRowLimit: 100 },
	};
	const versionId = randomUUID();
	const sourceId = randomUUID();
	const dataset: Dataset = {
		id: randomUUID(),
		projectId: project.id,
		name: "fixture.csv",
		originalFilename: "fixture.csv",
		format: "csv",
		createdAt: now,
		updatedAt: now,
		byteSize: SOURCE.length,
		sha256: "b".repeat(64),
		rowCount: 3,
		columnCount: 3,
		ingestionStatus: "ready",
		schemaVersion: 2,
		storageLocation: "private/storage/location",
		sourceVersionId: sourceId,
		currentVersionId: versionId,
		versions: [sourceId, versionId].map((id, index) => ({
			id,
			kind: index ? "derived" : "source",
			parentVersionId: index ? sourceId : null,
			storageLocation: `private/${id}`,
			createdAt: now,
			operation: { kind: "ingest", engine: "duckdb", version: "1" },
		})),
		schema: [
			{ index: 0, name: "category", sourceType: "VARCHAR", basicType: "text" },
			{ index: 1, name: "value", sourceType: "BIGINT", basicType: "number" },
			{ index: 2, name: "note", sourceType: "VARCHAR", basicType: "text" },
		],
		columns: [],
		parsing: { format: "csv", encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" },
		profileVersion: 1,
		profiledAt: now,
	};
	const state = {
		dataset,
		profile: computeDatasetProfile(
			{
				datasetVersionId: versionId,
				datasetVersionHash: "a".repeat(64),
				rowCount: 3,
				sourceBytes: SOURCE.length,
				storageBytes: 100,
				schema: dataset.schema,
			},
			[
				["a", "1", "private-cell-never-send"],
				["a", "3", "private-second"],
				["b", "5", "private-third"],
			],
			{ method: "full", populationRows: 3, sampleSize: 3, stride: 1, byteLimited: false, approximate: false },
			now,
		),
		writes: [] as AssistantRun[],
		runs: new Map<string, AssistantRun>(),
		charts: new Map<string, ChartRecord>(),
		previewCalls: 0,
	};
	function scope(projectId: string, datasetId = dataset.id) {
		if (projectId !== project.id || datasetId !== dataset.id) throw new WorkbenchError(404, "Not found.");
	}
	function stored(projectId: string, datasetId: string, runId: string) {
		scope(projectId, datasetId);
		const run = state.runs.get(runId);
		if (!run) throw new WorkbenchError(404, "Not found.");
		return structuredClone(run);
	}
	const store: ServiceStore = {
		getProject(projectId) {
			scope(projectId);
			return structuredClone(project);
		},
		async getDataset(projectId, datasetId) {
			scope(projectId, datasetId);
			return structuredClone(state.dataset);
		},
		async getProfile(projectId, datasetId) {
			scope(projectId, datasetId);
			return structuredClone(state.profile);
		},
		async listCharts(projectId, datasetId) {
			scope(projectId, datasetId);
			return structuredClone([...state.charts.values()]);
		},
		async assistantRuns(projectId, datasetId) {
			scope(projectId, datasetId);
			return structuredClone([...state.runs.values()]);
		},
		async assistantRun(projectId, datasetId, runId) {
			return stored(projectId, datasetId, runId);
		},
		async putAssistantRun(run) {
			scope(run.projectId, run.datasetId);
			state.runs.set(run.id, structuredClone(run));
			state.writes.push(structuredClone(run));
		},
		async chartPreview(projectId, datasetId, value, signal) {
			scope(projectId, datasetId);
			if (signal?.aborted) throw new WorkbenchError(409, "Cancelled.");
			state.previewCalls++;
			return {
				spec: structuredClone(value) as ChartSpec,
				datasetVersionHash: state.profile.datasetVersionHash,
				generatedAt: now,
				populationRows: 3,
				sampleSize: 3,
				stride: 1,
				byteLimited: false,
				sampled: false,
				filteredRows: 3,
				excludedRows: 0,
				omittedMarks: 0,
				marks: [],
				table: { columns: [], rows: [] },
				warnings: [],
				labels: {
					x: "category",
					y: "value",
					color: "",
					size: "",
					facet: "",
					aggregation: "sum",
					filters: "",
					missing: "",
				},
			};
		},
		async applyAssistantChart(run, suggestionId, name) {
			const current = stored(run.projectId, run.datasetId, run.id);
			const suggestion = current.suggestions.find((item) => item.id === suggestionId)!;
			assert.equal(suggestion.status, "accepted");
			if (suggestion.proposedAction.kind !== "chart") throw new Error("Expected chart fixture.");
			const chartId = randomUUID();
			state.charts.set(chartId, {
				id: chartId,
				projectId: run.projectId,
				datasetId: run.datasetId,
				name,
				createdAt: now,
				updatedAt: now,
				spec: suggestion.proposedAction.spec,
			});
			suggestion.status = "applied";
			suggestion.chartId = chartId;
			state.runs.set(run.id, structuredClone(current));
			return current;
		},
		async revertAssistantChart(run, suggestionId) {
			const current = stored(run.projectId, run.datasetId, run.id);
			const suggestion = current.suggestions.find((item) => item.id === suggestionId)!;
			assert.equal(suggestion.status, "applied");
			assert.ok(suggestion.chartId);
			state.charts.delete(suggestion.chartId);
			suggestion.status = "reverted";
			state.runs.set(run.id, structuredClone(current));
			return current;
		},
	};
	const driver = new LocalDriver();
	const service = new AssistantService(store, driver);
	context.after(() => service.close());
	return { project, dataset, state, store, driver, service };
}

async function completed(
	service: AssistantService,
	projectId: string,
	datasetId: string,
	runId: string,
): Promise<AssistantRun> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const run = await service.get(projectId, datasetId, runId);
		if (run.state !== "running") return run;
		await nextTurn();
	}
	throw new Error("Local assistant did not settle.");
}

async function started(driver: LocalDriver): Promise<void> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (driver.calls.length) return;
		await nextTurn();
	}
	throw new Error("Local driver was not called.");
}

async function runFixture(service: AssistantService, projectId: string, dataset: Dataset): Promise<AssistantRun> {
	const draft = await service.prepare(projectId, dataset.id, selection(dataset));
	const run = await service.start(projectId, dataset.id, { draftId: draft.id, payloadHash: draft.payloadHash });
	return completed(service, projectId, dataset.id, run.id);
}

test("approval sends exact staged payload once, never rows, paths, or previous turns", async (context) => {
	const { service, driver, project, dataset } = memoryFixture(context);
	const draft = await service.prepare(project.id, dataset.id, selection(dataset, "FIRST-TURN-ONLY"));
	const approved = structuredClone(draft.payload);
	assert.equal(driver.calls.length, 0);
	assert.doesNotMatch(JSON.stringify(draft), /private-cell-never-send|private\/storage|private-second|private-third/);
	assert.equal(draft.context.rowsIncluded, false);
	assert.deepEqual(
		draft.context.schema.map((column) => column.index),
		[0, 1],
	);
	draft.payload.system = "Mutated caller copy";
	draft.context.dataset.artifactHash = "c".repeat(64);
	const run = await service.start(project.id, dataset.id, { draftId: draft.id, payloadHash: draft.payloadHash });
	assert.equal(run.state, "running");
	assert.deepEqual(run.suggestions, []);
	const result = await completed(service, project.id, dataset.id, run.id);
	assert.equal(result.state, "completed");
	assert.deepEqual(driver.calls[0].input, { provider: "local-test", modelId: "fixture-model", payload: approved });
	assert.equal(result.suggestions[0].status, "proposed");
	assert.equal(result.suggestions[0].basis, "evidence-linked");
	assert.equal(result.suggestions[0].chartId, null);
	await assert.rejects(
		service.start(project.id, dataset.id, { draftId: draft.id, payloadHash: draft.payloadHash }),
		status(404),
	);
	const next = await service.prepare(project.id, dataset.id, selection(dataset, "SECOND-TURN-ONLY"));
	assert.doesNotMatch(next.payload.user, /FIRST-TURN-ONLY|Aggregate comparison/);
	const nextRun = await service.start(project.id, dataset.id, { draftId: next.id, payloadHash: next.payloadHash });
	await completed(service, project.id, dataset.id, nextRun.id);
	assert.equal(driver.calls.length, 2);
});

test("approval rejects tampering, changed model availability, profile, and version without sending", async (context) => {
	const { service, driver, project, dataset, state } = memoryFixture(context);
	const draft = await service.prepare(project.id, dataset.id, selection(dataset));
	const approval = { draftId: draft.id, payloadHash: draft.payloadHash };
	await assert.rejects(
		service.start(project.id, dataset.id, { ...approval, payloadHash: "0".repeat(64) }),
		status(409),
	);
	await assert.rejects(service.start(project.id, dataset.id, { ...approval, modelId: "different" }), status(400));
	await assert.rejects(service.start(project.id, dataset.id, { ...approval, payload: draft.payload }), status(400));
	driver.configured = false;
	await assert.rejects(service.start(project.id, dataset.id, approval), status(409));
	driver.configured = true;
	state.profile.profiledAt = new Date(Date.now() + 1000).toISOString();
	await assert.rejects(service.start(project.id, dataset.id, approval), status(409));
	const fresh = await service.prepare(project.id, dataset.id, selection(dataset));
	state.dataset.currentVersionId = randomUUID();
	await assert.rejects(
		service.start(project.id, dataset.id, { draftId: fresh.id, payloadHash: fresh.payloadHash }),
		status(409),
	);
	assert.equal(driver.calls.length, 0);
	assert.equal(state.runs.size, 0);
});

test("all scoped methods reject other projects, datasets, and run identifiers", async (context) => {
	const { service, driver, project, dataset } = memoryFixture(context);
	const run = await runFixture(service, project.id, dataset);
	const draft = await service.prepare(project.id, dataset.id, selection(dataset));
	for (const [projectId, datasetId] of [
		[randomUUID(), dataset.id],
		[project.id, randomUUID()],
	]) {
		for (const operation of [
			() => service.prepare(projectId, datasetId, selection(dataset)),
			() => service.start(projectId, datasetId, { draftId: draft.id, payloadHash: draft.payloadHash }),
			() => service.list(projectId, datasetId),
			() => service.get(projectId, datasetId, run.id),
			() => service.cancel(projectId, datasetId, run.id),
			() => service.transition(projectId, datasetId, run.id, "chart-0", { status: "accepted" }),
			() => service.preview(projectId, datasetId, run.id, "chart-0"),
			() => service.apply(projectId, datasetId, run.id, "chart-0", { previewId: randomUUID() }),
			() => service.revert(projectId, datasetId, run.id, "chart-0"),
		])
			await assert.rejects(operation(), status(404));
	}
	for (const operation of [
		() => service.get(project.id, dataset.id, randomUUID()),
		() => service.cancel(project.id, dataset.id, randomUUID()),
		() => service.transition(project.id, dataset.id, randomUUID(), "chart-0", { status: "accepted" }),
		() => service.preview(project.id, dataset.id, randomUUID(), "chart-0"),
		() => service.apply(project.id, dataset.id, randomUUID(), "chart-0", { previewId: randomUUID() }),
		() => service.revert(project.id, dataset.id, randomUUID(), "chart-0"),
	])
		await assert.rejects(operation(), status(404));
	assert.equal(driver.calls.length, 1);
});

test("drafts are globally bounded and expire after ten minutes", async (context) => {
	const { service, driver, project, dataset } = memoryFixture(context);
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const drafts = [];
	for (let index = 0; index < 10; index++)
		drafts.push(await service.prepare(project.id, dataset.id, selection(dataset)));
	await assert.rejects(service.prepare(project.id, dataset.id, selection(dataset)), status(409));
	context.mock.timers.tick(10 * 60_000 + 1);
	await assert.rejects(
		service.start(project.id, dataset.id, { draftId: drafts[0].id, payloadHash: drafts[0].payloadHash }),
		status(404),
	);
	await service.prepare(project.id, dataset.id, selection(dataset));
	assert.equal(driver.calls.length, 0);
	await service.close();
	context.mock.timers.reset();
});

test("cancellation retains the provider slot until settlement and ignores late output", async (context) => {
	const { service, driver, project, dataset } = memoryFixture(context);
	const result = deferred<GenerationResult>();
	driver.handle = () => result.promise;
	const first = await service.prepare(project.id, dataset.id, selection(dataset));
	const second = await service.prepare(project.id, dataset.id, selection(dataset));
	const running = await service.start(project.id, dataset.id, { draftId: first.id, payloadHash: first.payloadHash });
	await started(driver);
	const cancelled = service.cancel(project.id, dataset.id, running.id);
	await delay(1);
	assert.equal(driver.calls[0].signal.aborted, true);
	await assert.rejects(
		service.start(project.id, dataset.id, { draftId: second.id, payloadHash: second.payloadHash }),
		status(409),
	);
	result.resolve({ text: output(first.payload), usage: USAGE });
	const ended = await cancelled;
	assert.equal(ended.state, "cancelled");
	assert.deepEqual(ended.suggestions, []);
	driver.calls[0].onProgress({ type: "progress", receivedCharacters: 100_000 });
	assert.equal((await service.get(project.id, dataset.id, running.id)).receivedCharacters, 0);
	driver.handle = async (input) => ({ text: output(input.payload), usage: USAGE });
	const next = await service.start(project.id, dataset.id, { draftId: second.id, payloadHash: second.payloadHash });
	assert.equal((await completed(service, project.id, dataset.id, next.id)).state, "completed");
});

test("five-minute deadline aborts generation and rejects a late valid response", async (context) => {
	const { service, driver, project, dataset } = memoryFixture(context);
	const result = deferred<GenerationResult>();
	driver.handle = () => result.promise;
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const draft = await service.prepare(project.id, dataset.id, selection(dataset));
	const run = await service.start(project.id, dataset.id, { draftId: draft.id, payloadHash: draft.payloadHash });
	await started(driver);
	context.mock.timers.tick(ASSISTANT_TIMEOUT_MS + 1);
	assert.equal(driver.calls[0].signal.aborted, true);
	result.resolve({ text: output(draft.payload), usage: USAGE });
	const ended = await completed(service, project.id, dataset.id, run.id);
	assert.equal(ended.state, "failed");
	assert.match(ended.error!, /five-minute/);
	assert.deepEqual(ended.suggestions, []);
	await service.close();
	context.mock.timers.reset();
});

test("progress persists coalesced monotonic counts only, with safe provider errors", async (context) => {
	const { service, driver, project, dataset, state } = memoryFixture(context);
	const result = deferred<GenerationResult>();
	driver.handle = () => result.promise;
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const draft = await service.prepare(project.id, dataset.id, selection(dataset));
	const run = await service.start(project.id, dataset.id, { draftId: draft.id, payloadHash: draft.payloadHash });
	await started(driver);
	const progress = driver.calls[0].onProgress;
	for (let index = 1; index <= 50; index++) progress({ type: "progress", receivedCharacters: index });
	progress({ type: "progress", receivedCharacters: 2 });
	progress({ type: "usage", usage: USAGE });
	progress({ type: "usage", usage: { ...USAGE, input: 1, output: 0, totalTokens: 1 } });
	assert.equal(state.writes.length, 1);
	context.mock.timers.tick(100);
	await nextTurn();
	assert.equal(state.writes.length, 2);
	const current = await service.get(project.id, dataset.id, run.id);
	assert.equal(current.receivedCharacters, 50);
	assert.deepEqual(current.usage, USAGE);
	assert.deepEqual(current.suggestions, []);
	assert.equal(current.summary, "");
	result.reject(new Error("SECRET_API_KEY private-cell-never-send C:/credential/path raw-provider-output"));
	const ended = await completed(service, project.id, dataset.id, run.id);
	assert.equal(ended.state, "failed");
	assert.match(ended.error!, /credentials/);
	assert.doesNotMatch(
		JSON.stringify(state.writes),
		/SECRET_API_KEY|private-cell-never-send|credential\/path|raw-provider-output/,
	);
	await service.close();
	context.mock.timers.reset();
});

test("malformed output rejects every suggestion without partial results or hidden retries", async (context) => {
	const { service, driver, project, dataset } = memoryFixture(context);
	driver.handle = async (input) => {
		const body = JSON.parse(output(input.payload));
		body.suggestions.push({ ...body.suggestions[0], id: "second", status: "applied", chartId: "forged" });
		return { text: JSON.stringify(body), usage: USAGE };
	};
	const run = await runFixture(service, project.id, dataset);
	assert.equal(run.state, "failed");
	assert.match(run.error!, /schema/);
	assert.deepEqual(run.suggestions, []);
	assert.equal(run.summary, "");
	assert.equal(driver.calls.length, 1);
});

test("preview acceptance, failed retry, identity, expiration, and duplicate applications are enforced", async (context) => {
	const { service, driver, project, dataset, store, state } = memoryFixture(context);
	driver.handle = async (input) => ({ text: output(input.payload, 2), usage: USAGE });
	const run = await runFixture(service, project.id, dataset);
	await assert.rejects(service.preview(project.id, dataset.id, run.id, "chart-0"), status(409));
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
	await assert.rejects(
		service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: randomUUID() }),
		status(409),
	);
	const previewFailure = context.mock.method(store, "chartPreview", async () => {
		throw new Error("private worker path");
	});
	await assert.rejects(service.preview(project.id, dataset.id, run.id, "chart-0"), status(500));
	assert.equal((await service.get(project.id, dataset.id, run.id)).suggestions[0].status, "failed");
	await assert.rejects(service.preview(project.id, dataset.id, run.id, "chart-0"), status(409));
	previewFailure.mock.restore();
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
	await service.transition(project.id, dataset.id, run.id, "chart-1", { status: "accepted" });
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const preview = await service.preview(project.id, dataset.id, run.id, "chart-0");
	assert.equal((await service.preview(project.id, dataset.id, run.id, "chart-0")).previewId, preview.previewId);
	assert.equal(state.previewCalls, 1);
	assert.equal(state.charts.size, 0);
	await assert.rejects(
		service.apply(project.id, dataset.id, run.id, "chart-1", { previewId: preview.previewId }),
		status(409),
	);
	context.mock.timers.tick(10 * 60_000 + 1);
	await assert.rejects(
		service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: preview.previewId }),
		status(409),
	);
	const refreshed = await service.preview(project.id, dataset.id, run.id, "chart-0");
	const application = await Promise.allSettled([
		service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: refreshed.previewId }),
		service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: refreshed.previewId }),
	]);
	assert.equal(application.filter((item) => item.status === "fulfilled").length, 1);
	assert.equal(application.filter((item) => item.status === "rejected").length, 1);
	assert.equal(state.charts.size, 1);
	assert.equal(driver.calls.length, 1);
	await service.close();
	context.mock.timers.reset();
});

test("read-only generated code cannot be previewed, applied, or reverted", async (context) => {
	const { service, driver, project, dataset, state } = memoryFixture(context);
	driver.handle = async (input) => {
		const body = JSON.parse(output(input.payload));
		body.suggestions[0].category = "modeling";
		body.suggestions[0].proposedAction = {
			kind: "read-only",
			description: "Validate target and leakage before training.",
		};
		body.suggestions[0].generatedCode = "raise RuntimeError('display only, never execute')";
		return { text: JSON.stringify(body), usage: USAGE };
	};
	const run = await runFixture(service, project.id, dataset);
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
	for (const operation of [
		() => service.preview(project.id, dataset.id, run.id, "chart-0"),
		() => service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: randomUUID() }),
		() => service.revert(project.id, dataset.id, run.id, "chart-0"),
	])
		await assert.rejects(operation(), status(409));
	await assert.rejects(
		service.transition(project.id, dataset.id, run.id, "chart-0", { status: "applied" }),
		status(400),
	);
	assert.equal(state.charts.size, 0);
	assert.equal(state.previewCalls, 0);
	assert.match(run.suggestions[0].generatedCode!, /display only/);
});

test("stale suggestions remain inspectable but cannot be previewed or applied", async (context) => {
	const { service, project, dataset, state } = memoryFixture(context);
	const run = await runFixture(service, project.id, dataset);
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
	const preview = await service.preview(project.id, dataset.id, run.id, "chart-0");
	state.dataset.currentVersionId = randomUUID();
	const historical = await service.get(project.id, dataset.id, run.id);
	assert.equal(historical.suggestions[0].status, "accepted");
	assert.match(historical.suggestions[0].error!, /changed dataset/);
	assert.match((await service.list(project.id, dataset.id))[0].suggestions[0].error!, /changed dataset/);
	await assert.rejects(
		service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: preview.previewId }),
		status(409),
	);
	await assert.rejects(service.preview(project.id, dataset.id, run.id, "chart-0"), status(409));
	assert.equal(state.charts.size, 0);
});

test("close aborts and awaits analytical previews without admitting new work", async (context) => {
	const { service, driver, project, dataset, store } = memoryFixture(context);
	const run = await runFixture(service, project.id, dataset);
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
	const entered = deferred<AbortSignal>();
	context.mock.method(
		store,
		"chartPreview",
		async (_projectId: string, _datasetId: string, _spec: unknown, signal?: AbortSignal) => {
			assert.ok(signal);
			entered.resolve(signal);
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new WorkbenchError(409, "Cancelled.");
		},
	);
	const preview = service.preview(project.id, dataset.id, run.id, "chart-0");
	const rejected = assert.rejects(preview, status(409));
	const signal = await entered.promise;
	await service.close();
	await rejected;
	assert.equal(signal.aborted, true);
	await assert.rejects(service.models(), status(503));
	assert.equal(driver.calls.length, 1);
});

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(10);
	}
	throw new Error("Assistant dataset fixture did not settle.");
}

test(
	"real storage previews, saves once, persists history, and reverts only its unchanged chart",
	{ timeout: 120_000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "workbench-assistant-service-"));
		let store = new WorkbenchStore(root);
		const driver = new LocalDriver();
		let service = new AssistantService(store, driver);
		context.after(async () => {
			await service.close();
			await store.close();
			await rm(root, { recursive: true, force: true });
		});
		await store.init();
		const project = await store.createProject("Assistant chart lifecycle");
		const job = await store.createImport(project.id, "fixture.csv");
		await store.upload(
			project.id,
			job.id,
			(async function* () {
				yield Buffer.from(SOURCE);
			})(),
		);
		const imported = await waitJob(store, project.id, job.id);
		assert.equal(imported.state, "completed", imported.error);
		assert.ok(imported.datasetId);
		const dataset = await store.getDataset(project.id, imported.datasetId);
		const profile = await store.profile(project.id, dataset.id);
		assert.equal((await waitJob(store, project.id, profile.id)).state, "completed");
		const run = await runFixture(service, project.id, dataset);
		assert.equal(run.state, "completed", run.error ?? undefined);
		await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
		const preview = await service.preview(project.id, dataset.id, run.id, "chart-0");
		assert.deepEqual(
			preview.chart.marks.map((mark) => mark.value),
			[4, 5],
		);
		assert.equal((await store.listCharts(project.id, dataset.id)).length, 0);
		const applied = await service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: preview.previewId });
		assert.equal(applied.suggestions[0].status, "applied");
		const chart = (await store.listCharts(project.id, dataset.id))[0];
		assert.equal(chart.id, applied.suggestions[0].chartId);
		await store.updateChart(project.id, dataset.id, chart.id, chart.name, { ...chart.spec, sort: "descending" });
		await assert.rejects(service.revert(project.id, dataset.id, run.id, "chart-0"), status(409));
		assert.equal((await store.listCharts(project.id, dataset.id)).length, 1);
		await store.updateChart(project.id, dataset.id, chart.id, chart.name, chart.spec);
		await service.close();
		await store.close();
		store = new WorkbenchStore(root);
		await store.init();
		service = new AssistantService(store, driver);
		assert.equal((await service.list(project.id, dataset.id))[0].suggestions[0].status, "applied");
		const reverted = await service.revert(project.id, dataset.id, run.id, "chart-0");
		assert.equal(reverted.suggestions[0].status, "reverted");
		assert.equal(reverted.suggestions[0].chartId, chart.id);
		assert.equal((await store.listCharts(project.id, dataset.id)).length, 0);
		await assert.rejects(service.revert(project.id, dataset.id, run.id, "chart-0"), status(409));
		assert.equal(driver.calls.length, 1);
	},
);

test("preview cache is bounded by eight entries and four MiB per result", async (context) => {
	const { service, driver, project, dataset, store, state } = memoryFixture(context);
	driver.handle = async (input) => ({ text: output(input.payload, 9), usage: USAGE });
	const run = await runFixture(service, project.id, dataset);
	for (let index = 0; index < 9; index++)
		await service.transition(project.id, dataset.id, run.id, `chart-${index}`, { status: "accepted" });
	for (let index = 0; index < 8; index++) await service.preview(project.id, dataset.id, run.id, `chart-${index}`);
	await assert.rejects(service.preview(project.id, dataset.id, run.id, "chart-8"), status(409));
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "rejected" });
	const original = store.chartPreview.bind(store);
	context.mock.method(store, "chartPreview", async (...args: Parameters<ServiceStore["chartPreview"]>) => {
		const result = await original(...args);
		result.warnings = ["x".repeat(4 * 1024 * 1024)];
		return result;
	});
	await assert.rejects(service.preview(project.id, dataset.id, run.id, "chart-8"), status(409));
	assert.equal((await service.get(project.id, dataset.id, run.id)).suggestions[8].status, "failed");
	assert.equal(state.charts.size, 0);
});

test("cancel invalidates a preview while apply is rechecking the profile", async (context) => {
	const { service, project, dataset, store, state } = memoryFixture(context);
	const run = await runFixture(service, project.id, dataset);
	await service.transition(project.id, dataset.id, run.id, "chart-0", { status: "accepted" });
	const preview = await service.preview(project.id, dataset.id, run.id, "chart-0");
	const entered = deferred<void>();
	const release = deferred<void>();
	context.mock.method(store, "getProfile", async () => {
		entered.resolve();
		await release.promise;
		return structuredClone(state.profile);
	});
	const applying = service.apply(project.id, dataset.id, run.id, "chart-0", { previewId: preview.previewId });
	const rejected = assert.rejects(applying, status(409));
	await entered.promise;
	const cancelling = service.cancel(project.id, dataset.id, run.id);
	await delay(1);
	release.resolve();
	await rejected;
	await cancelling;
	assert.equal(state.charts.size, 0);
	assert.equal((await service.get(project.id, dataset.id, run.id)).suggestions[0].status, "accepted");
});

test("shutdown waits for cancelled provider settlement and discards late output", async (context) => {
	const { service, driver, project, dataset, state } = memoryFixture(context);
	const result = deferred<GenerationResult>();
	driver.handle = () => result.promise;
	const draft = await service.prepare(project.id, dataset.id, selection(dataset));
	const run = await service.start(project.id, dataset.id, { draftId: draft.id, payloadHash: draft.payloadHash });
	await started(driver);
	let closed = false;
	const closing = service.close().then(() => {
		closed = true;
	});
	await delay(1);
	assert.equal(driver.calls[0].signal.aborted, true);
	assert.equal(closed, false);
	result.resolve({ text: output(draft.payload), usage: USAGE });
	await closing;
	assert.equal(state.runs.get(run.id)?.state, "cancelled");
	assert.deepEqual(state.runs.get(run.id)?.suggestions, []);
});
