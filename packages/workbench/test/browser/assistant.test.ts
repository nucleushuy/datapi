import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window as TestWindow } from "happy-dom";
import type {
	AssistantContext,
	AssistantDraft,
	AssistantModels,
	AssistantRun,
	AssistantSelection,
	AssistantSuggestion,
} from "../../src/assistant-contracts.ts";
import type { ChartResult, ChartSpec } from "../../src/chart-contracts.ts";
import { defaultChartSpec } from "../../src/chart-spec.ts";
import type { Bootstrap, Dataset, Project } from "../../src/contracts.ts";
import type { DatasetProfile } from "../../src/profile-contracts.ts";

const html = await readFile(new URL("../../src/browser/index.html", import.meta.url), "utf8");
const bundle = await build({
	entryPoints: [fileURLToPath(new URL("../../src/browser/app.ts", import.meta.url))],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
});
const script = bundle.outputFiles[0].text;
const timestamp = "2026-09-24T12:00:00.000Z";
const hostile = '<img src=x onerror="alert(1)">';
const project: Project = {
	id: "assistant-project",
	ownerId: null,
	name: "Analysis",
	description: "Local project",
	createdAt: timestamp,
	updatedAt: timestamp,
	settings: { previewRowLimit: 100 },
};
const otherProject: Project = { ...project, id: "other-project", name: "Other project" };
const dataset: Dataset = {
	id: "assistant-data",
	projectId: project.id,
	name: "observations.csv",
	originalFilename: "observations.csv",
	format: "csv",
	createdAt: timestamp,
	updatedAt: timestamp,
	byteSize: 100,
	sha256: "a".repeat(64),
	rowCount: 100,
	columnCount: 2,
	ingestionStatus: "ready",
	schemaVersion: 2,
	storageLocation: "source.csv",
	sourceVersionId: "source-one",
	currentVersionId: "version-one",
	versions: [
		{
			id: "version-one",
			kind: "derived",
			parentVersionId: "source-one",
			storageLocation: "data.parquet",
			createdAt: timestamp,
			operation: { kind: "ingest", engine: "duckdb", version: "1" },
		},
	],
	schema: [
		{ index: 0, name: "Amount", sourceType: "DOUBLE", basicType: "number" },
		{ index: 1, name: hostile, sourceType: "VARCHAR", basicType: "text" },
	],
	columns: [
		{ index: 0, name: "Amount", inferredType: "number", emptyCount: 0, numericCount: 100, min: 1, max: 100 },
		{ index: 1, name: hostile, inferredType: "text", emptyCount: 0, numericCount: 0, min: null, max: null },
	],
	parsing: { format: "csv", encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" },
	profileVersion: 1,
	profiledAt: timestamp,
};
const otherDataset: Dataset = {
	...dataset,
	id: "other-data",
	projectId: otherProject.id,
	currentVersionId: "version-two",
	name: "other.csv",
};
const profile: DatasetProfile = {
	profilerVersion: 1,
	datasetVersionId: dataset.currentVersionId,
	datasetVersionHash: "b".repeat(64),
	profiledAt: timestamp,
	rowCount: 100,
	columnCount: 2,
	sourceBytes: 100,
	storageBytes: 100,
	estimatedMemoryBytes: 400,
	duplicateCount: 0,
	sampling: {
		method: "systematic",
		populationRows: 100,
		sampleSize: 10,
		stride: 10,
		approximate: true,
		byteLimited: false,
	},
	issues: [],
	limitations: ["Sample only"],
	columns: dataset.schema.map((column) => ({
		index: column.index,
		name: column.name,
		originalType: column.sourceType,
		semanticTypes: [
			{ type: column.index === 0 ? "numeric" : "categorical", confidence: 0.95, reason: "Observed profile" },
		],
		nullCount: 0,
		nullPercentage: 0,
		emptyStringCount: 0,
		distinctCount: 3,
		distinctPercentage: 30,
		examples: [],
		topValues: [],
		limitations: [],
		numeric: null,
	})),
};
const context: AssistantContext = {
	version: 1,
	project: { id: project.id, name: project.name, description: project.description },
	dataset: {
		id: dataset.id,
		name: dataset.name,
		versionId: dataset.currentVersionId,
		artifactHash: profile.datasetVersionHash,
		rowCount: 100,
		columnCount: 2,
	},
	schema: dataset.schema,
	selectedColumns: [0],
	filters: [],
	evidence: [
		{ id: "fact-1", metric: "null count", value: 0, columns: [0], basis: "sample", rows: 10, approximate: false },
	],
	artifacts: [],
	limitations: ["Statistics describe sampled rows only"],
	rowsIncluded: false,
};
const spec: ChartSpec = { ...defaultChartSpec(dataset.currentVersionId), x: 1 };
const suggestion: AssistantSuggestion = {
	id: "suggestion-one",
	category: "visualization",
	title: hostile,
	explanation: "Compare observed counts; this does not establish failure rates.",
	priority: "high",
	confidence: 0.7,
	evidenceRefs: ["fact-1"],
	affectedColumns: [1],
	proposedAction: { kind: "chart", spec },
	generatedCode: `print('${hostile}')`,
	status: "proposed",
	basis: "evidence-linked",
	chartId: null,
	error: null,
};
function run(id = "run-one", state: AssistantRun["state"] = "completed"): AssistantRun {
	return {
		id,
		projectId: project.id,
		datasetId: dataset.id,
		datasetVersionId: dataset.currentVersionId,
		provider: "provider-a",
		modelId: "model-a",
		createdAt: timestamp,
		updatedAt: timestamp,
		state,
		request: "Compare counts",
		context,
		payloadHash: "approved-hash",
		summary: "A bounded chart proposal.",
		suggestions: state === "completed" ? [structuredClone(suggestion)] : [],
		usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 3, totalTokens: 25 },
		latencyMs: 500,
		receivedCharacters: state === "completed" ? 100 : 0,
		error: null,
	};
}
function chartResult(chartSpec = spec): ChartResult {
	return {
		spec: chartSpec,
		datasetVersionHash: profile.datasetVersionHash,
		generatedAt: timestamp,
		populationRows: 100,
		sampleSize: 10,
		stride: 10,
		byteLimited: false,
		sampled: true,
		filteredRows: 8,
		excludedRows: 1,
		omittedMarks: 0,
		marks: [
			{
				x: "group",
				y: 8,
				value: 8,
				color: null,
				size: null,
				facet: null,
				low: null,
				high: null,
				q1: null,
				median: null,
				q3: null,
				rowIds: [],
			},
		],
		table: { columns: dataset.schema, rows: [] },
		warnings: ["Bounded sample only; no population estimate."],
		labels: {
			x: hostile,
			y: "Count",
			color: "None",
			size: "None",
			facet: "None",
			aggregation: "count",
			filters: "None",
			missing: "Missing excluded",
		},
	};
}
async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Expected assistant state did not settle");
		await pause(1);
	}
}
function deferred() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}
async function setup(
	t: TestContext,
	options: {
		history?: AssistantRun[];
		profile?: DatasetProfile | null;
		configured?: boolean;
		respond?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
	} = {},
) {
	const browser = new TestWindow({
		url: "http://localhost:4310",
		width: 1440,
		height: 900,
		settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
	});
	t.after(() => browser.happyDOM.close());
	browser.document.write(html);
	const requests: { path: string; init: RequestInit }[] = [];
	const saved = new Map((options.history ?? []).map((value) => [value.id, structuredClone(value)]));
	let configured = options.configured ?? true;
	let draftCounter = 0;
	let latestDraft: AssistantDraft | null = null;
	const respond = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const path = String(input);
		requests.push({ path, init });
		const override = options.respond?.(path, init);
		if (override) return override;
		if (path === "/api/bootstrap")
			return Response.json({
				token: "assistant-token",
				projects: [project, otherProject],
				maxUploadBytes: 100_000_000,
				maxDecodedBytes: 256 * 1024 * 1024,
				maxPreviewRows: 500,
			} satisfies Bootstrap);
		if (path === `/api/projects/${project.id}/datasets`) return Response.json([dataset]);
		if (path === `/api/projects/${otherProject.id}/datasets`) return Response.json([otherDataset]);
		if (path.endsWith(`/datasets/${dataset.id}`)) return Response.json(dataset);
		if (path.endsWith(`/datasets/${otherDataset.id}`)) return Response.json(otherDataset);
		if (path.endsWith("/profile"))
			return Response.json({
				profile:
					options.profile === null
						? null
						: {
								...(options.profile ?? profile),
								datasetVersionId: path.includes(otherProject.id)
									? otherDataset.currentVersionId
									: dataset.currentVersionId,
							},
			});
		if (path.includes("/preview?"))
			return Response.json({ offset: 0, limit: 100, total: 100, rows: [["1", "original row not for AI"]] });
		if (path.endsWith("/charts")) return Response.json([]);
		if (path === "/api/assistant/models")
			return Response.json({
				models: [
					{ provider: "provider-a", id: "model-a", name: "Model A", configured, contextWindow: 32000 },
					{ provider: "provider-b", id: "model-b", name: "Model B", configured: true, contextWindow: 32000 },
				],
				guidance: "Explicit keys only.",
			} satisfies AssistantModels);
		if (path.startsWith("/api/assistant/credentials")) {
			configured = init.method !== "DELETE";
			return Response.json({ saved: true });
		}
		if (path.endsWith("/assistant/prepare")) {
			const selection: AssistantSelection = JSON.parse(String(init.body));
			latestDraft = {
				id: `draft-${++draftCounter}`,
				projectId: project.id,
				datasetId: dataset.id,
				provider: selection.provider,
				modelId: selection.modelId,
				createdAt: timestamp,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
				payloadHash: "approved-hash",
				payload: {
					system: `Exact system message ${hostile}`,
					user: JSON.stringify({
						request: selection.request,
						context: { ...context, selectedColumns: selection.selectedColumns, filters: selection.filters },
					}),
				},
				context: { ...context, selectedColumns: selection.selectedColumns, filters: selection.filters },
			};
			return Response.json(latestDraft);
		}
		if (path.endsWith("/assistant/runs") && init.method === "POST") {
			const next = {
				...run(`new-run-${saved.size + 1}`, "running"),
				provider: latestDraft!.provider,
				modelId: latestDraft!.modelId,
				context: latestDraft!.context,
			};
			saved.set(next.id, next);
			return Response.json(next, { status: 202 });
		}
		if (path.endsWith("/assistant/runs"))
			return Response.json(path.includes(otherProject.id) ? [] : [...saved.values()]);
		const runMatch = /\/assistant\/runs\/([^/]+)$/.exec(path);
		if (runMatch) {
			const value = saved.get(runMatch[1])!;
			if (init.method === "DELETE") {
				value.state = "cancelled";
				value.latencyMs = 650;
			}
			return Response.json(value);
		}
		const suggestionMatch = /\/assistant\/runs\/([^/]+)\/suggestions\/([^/]+)\/(status|preview|apply|revert)$/.exec(
			path,
		);
		if (suggestionMatch) {
			const value = saved.get(suggestionMatch[1])!;
			const item = value.suggestions.find((item) => item.id === suggestionMatch[2])!;
			const action = suggestionMatch[3];
			if (action === "preview") return Response.json({ previewId: "preview-one", chart: chartResult() });
			if (action === "status") item.status = JSON.parse(String(init.body)).status;
			if (action === "apply") {
				item.status = "applied";
				item.chartId = "saved-chart";
			}
			if (action === "revert") {
				item.status = "reverted";
				item.chartId = null;
			}
			return Response.json(value);
		}
		throw new Error(`Unexpected assistant request: ${init.method ?? "GET"} ${path}`);
	};
	browser.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const response = await respond(input, init);
		const text = await response.text();
		// Fetch JSON belongs to the browser realm, not Node's Response realm.
		response.json = async () => browser.eval(`JSON.parse(${JSON.stringify(text)})`);
		return response;
	}) as unknown as typeof browser.fetch;
	const document = browser.document as unknown as Document;
	function element<T extends HTMLElement = HTMLElement>(id: string): T {
		const value = document.getElementById(id);
		assert.ok(value, id);
		return value as T;
	}
	function change(id: string, value: string, event = "change") {
		element<HTMLInputElement>(id).value = value;
		element(id).dispatchEvent(new browser.Event(event, { bubbles: true }) as unknown as Event);
	}
	function approve() {
		element<HTMLInputElement>("assistant-reviewed").checked = true;
		element("assistant-reviewed").dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
	}
	browser.eval(script);
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	async function activate() {
		element("assistant-open").click();
		await waitFor(
			() =>
				!element<HTMLButtonElement>("assistant-refresh-history").disabled &&
				element<HTMLSelectElement>("assistant-model").options.length > 0 &&
				!element<HTMLButtonElement>("assistant-refresh-models").disabled,
		);
		change("assistant-provider", "provider-a");
		change("assistant-model", "model-a");
	}
	async function prepareRequest(text = "Compare counts") {
		change("assistant-request", text, "input");
		assert.equal(
			element<HTMLButtonElement>("assistant-prepare").disabled,
			false,
			JSON.stringify({
				provider: element<HTMLSelectElement>("assistant-provider").value,
				model: element<HTMLSelectElement>("assistant-model").value,
				context: element("assistant-context-status").textContent,
				columns: element("assistant-column-status").textContent,
				status: element("assistant-status").textContent,
			}),
		);
		element("assistant-prepare").click();
		await waitFor(() => !element("assistant-review").hidden);
	}
	return { browser, document, requests, element, change, approve, activate, prepareRequest, saved };
}

test("assistant bootstrap is inert; explicit setup loads only safe model metadata and scoped history", async (t) => {
	const { requests, element, activate } = await setup(t);
	assert.equal(
		requests.some(({ path }) => /\/assistant(?:\/|$)/.test(path)),
		false,
	);
	element("right-tab-suggestions").click();
	element("right-tab-assistant").click();
	assert.equal(
		requests.some(({ path }) => /\/assistant(?:\/|$)/.test(path)),
		false,
	);
	await activate();
	assert.equal(requests.filter(({ path }) => /\/assistant(?:\/|$)/.test(path)).length, 2);
	assert.match(element("assistant-selection").textContent ?? "", /0 rows/);
	assert.ok(
		requests
			.filter(({ path }) => /\/assistant(?:\/|$)/.test(path))
			.every(({ init }) => new Headers(init.headers).get("X-Workbench-Token") === "assistant-token"),
	);
});

test("missing current profile prevents preparation but keeps history and credential setup available", async (t) => {
	const { activate, element, change, requests, document } = await setup(t, { profile: null });
	await activate();
	change("assistant-request", "Compare counts", "input");
	assert.equal(element<HTMLButtonElement>("assistant-prepare").disabled, true);
	assert.match(element("assistant-context-status").textContent ?? "", /current saved profile is required/);
	element("assistant-profile").click();
	assert.equal(document.activeElement?.id, "run-profile");
	assert.equal(
		requests.some(({ path }) => path.endsWith("/prepare")),
		false,
	);
});

test("assistant field checkboxes choose exact sharing scope without constructing a chart and invalidate approval", async (t) => {
	const { activate, element, requests, prepareRequest, approve } = await setup(t);
	await activate();
	assert.equal(element<HTMLInputElement>("assistant-column-0").checked, true);
	assert.equal(element<HTMLInputElement>("assistant-column-1").checked, true);
	element("assistant-column-1").click();
	await prepareRequest("Inspect Amount only");
	const first = requests.filter(({ path }) => path.endsWith("/prepare")).at(-1)!;
	assert.deepEqual(JSON.parse(String(first.init.body)).selectedColumns, [0]);
	approve();
	element("assistant-column-1").click();
	assert.equal(element("assistant-review").hidden, true);
	assert.equal(element<HTMLInputElement>("assistant-reviewed").checked, false);
	await prepareRequest("Inspect both selected fields");
	const second = requests.filter(({ path }) => path.endsWith("/prepare")).at(-1)!;
	assert.deepEqual(JSON.parse(String(second.init.body)).selectedColumns, [0, 1]);
	element("assistant-column-0").click();
	element("assistant-column-1").click();
	assert.equal(element<HTMLButtonElement>("assistant-prepare").disabled, true);
	assert.match(element("assistant-column-status").textContent ?? "", /Select at least one/);
	element("assistant-use-default-columns").click();
	assert.equal(element<HTMLInputElement>("assistant-column-0").checked, true);
	assert.equal(element<HTMLInputElement>("assistant-column-1").checked, true);
	assert.equal(
		requests.some(({ path }) => path.endsWith("/chart-preview")),
		false,
	);
});

test("exact plain-text approval includes current chart fields and literal filters, and edits invalidate consent", async (t) => {
	const { activate, prepareRequest, element, change, approve, requests, document } = await setup(t);
	await activate();
	change("chart-x", "1");
	element("chart-add-filter").click();
	change("chart-filter-value-0", hostile, "input");
	await prepareRequest();
	const sent = JSON.parse(String(requests.find(({ path }) => path.endsWith("/prepare"))!.init.body));
	assert.deepEqual(sent.selectedColumns, [0, 1]);
	assert.deepEqual(sent.filters, [{ column: 0, op: "eq", value: hostile }]);
	assert.equal("rows" in sent, false);
	assert.equal(element("assistant-system-payload").textContent, `Exact system message ${hostile}`);
	assert.equal(JSON.parse(element("assistant-user-payload").textContent!).context.filters[0].value, hostile);
	assert.equal(document.querySelector("#assistant-workspace img"), null);
	assert.equal(element<HTMLButtonElement>("assistant-send").disabled, true);
	approve();
	assert.equal(element<HTMLButtonElement>("assistant-send").disabled, false);
	change("chart-sort", "descending");
	assert.equal(element("assistant-review").hidden, true);
	assert.equal(element<HTMLInputElement>("assistant-reviewed").checked, false);
	assert.equal(element<HTMLButtonElement>("assistant-send").disabled, true);
	assert.equal(
		requests.some(({ path, init }) => path.endsWith("/runs") && init.method === "POST"),
		false,
	);
	await prepareRequest("A new question");
	approve();
	change("assistant-provider", "provider-b");
	assert.equal(element("assistant-review").hidden, true);
	change("assistant-model", "model-b");
	await prepareRequest("Another independent question");
	approve();
	change("assistant-request", "Changed after review", "input");
	assert.equal(element("assistant-review").hidden, true);
});

test("a late preparation cannot reinstate approval after a chart selection change", async (t) => {
	const pending = deferred();
	const { activate, element, change, requests } = await setup(t, {
		respond(path) {
			if (path.endsWith("/prepare")) return pending.promise;
		},
	});
	await activate();
	change("assistant-request", "Compare counts", "input");
	element("assistant-prepare").click();
	await waitFor(() => requests.some(({ path }) => path.endsWith("/prepare")));
	const request = requests.find(({ path }) => path.endsWith("/prepare"))!;
	change("chart-x", "1");
	assert.equal(request.init.signal?.aborted, true);
	pending.resolve(
		Response.json({
			id: "late",
			projectId: project.id,
			datasetId: dataset.id,
			provider: "provider-a",
			modelId: "model-a",
			createdAt: timestamp,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			payloadHash: "late",
			payload: { system: "late", user: "late" },
			context,
		} satisfies AssistantDraft),
	);
	await pause(10);
	assert.equal(element("assistant-review").hidden, true);
	assert.equal(element<HTMLButtonElement>("assistant-send").disabled, true);
});

test("approved send transmits only the draft identity, reports metrics and cancels without erasing history", async (t) => {
	const { activate, prepareRequest, approve, element, requests, document } = await setup(t);
	await activate();
	await prepareRequest();
	approve();
	element("assistant-send").click();
	await waitFor(() => document.getElementById("assistant-run-state")?.textContent?.startsWith("RUNNING") === true);
	const sent = requests.find(({ path, init }) => path.endsWith("/runs") && init.method === "POST")!;
	assert.deepEqual(JSON.parse(String(sent.init.body)), { draftId: "draft-1", payloadHash: "approved-hash" });
	assert.match(element("assistant-run-metrics").textContent ?? "", /12 input.*8 output.*25 total/);
	assert.match(element("assistant-run-metrics").textContent ?? "", /2 read.*3 written/);
	assert.match(element("assistant-run-metrics").textContent ?? "", /500 ms/);
	assert.doesNotMatch(element("assistant-privacy-state").textContent ?? "", /No data sent|Local only/);
	element("assistant-cancel").click();
	await waitFor(() => element("assistant-run-state").textContent?.startsWith("CANCELLED") === true);
	assert.equal(element<HTMLSelectElement>("assistant-runs").options.length, 1);
	assert.equal(element("assistant-cancel").hidden, true);
	assert.ok(requests.some(({ path, init }) => path.endsWith("/runs/new-run-1") && init.method === "DELETE"));
});

test("credentials never enter browser storage or error display and deletion needs confirmation", async (t) => {
	const { activate, element, change, requests, browser, document } = await setup(t, { configured: false });
	await activate();
	change("assistant-request", "Compare counts", "input");
	assert.equal(element<HTMLButtonElement>("assistant-prepare").disabled, true);
	change("assistant-api-key", "test-secret-not-real", "input");
	element("assistant-save-key").click();
	assert.equal(element<HTMLInputElement>("assistant-api-key").value, "");
	await waitFor(() => !element<HTMLButtonElement>("assistant-prepare").disabled);
	assert.doesNotMatch(document.body.textContent ?? "", /test-secret-not-real/);
	for (const storage of [browser.localStorage, browser.sessionStorage])
		for (let index = 0; index < storage.length; index++)
			assert.doesNotMatch(storage.getItem(storage.key(index)!) ?? "", /test-secret-not-real/);
	element("assistant-delete-key").click();
	assert.equal(
		requests.some(({ path, init }) => path.includes("/credentials/") && init.method === "DELETE"),
		false,
	);
	element("assistant-keep-key").click();
	assert.equal(
		requests.some(({ path, init }) => path.includes("/credentials/") && init.method === "DELETE"),
		false,
	);
	element("assistant-delete-key").click();
	element("assistant-confirm-delete-key").click();
	await waitFor(() =>
		requests.some(({ path, init }) => path.endsWith("/credentials/provider-a") && init.method === "DELETE"),
	);
});

test("credential endpoint errors are never echoed even if the server includes the secret", async (t) => {
	const { activate, element, change, document } = await setup(t, {
		configured: false,
		respond(path) {
			if (path === "/api/assistant/credentials")
				return Response.json({ error: "secret-from-response" }, { status: 400 });
		},
	});
	await activate();
	change("assistant-api-key", "secret-from-response", "input");
	element("assistant-save-key").click();
	await waitFor(() => !element("assistant-credential-error").hidden);
	assert.equal(element<HTMLInputElement>("assistant-api-key").value, "");
	assert.doesNotMatch(document.body.textContent ?? "", /secret-from-response/);
	assert.match(element("assistant-credential-error").textContent ?? "", /could not be confirmed/);
});

test("chart suggestions require accept, matching local preview, explicit apply and confirmed chart-only revert", async (t) => {
	const { activate, element, requests, document } = await setup(t, { history: [run()] });
	await activate();
	element("assistant-show-suggestions").click();
	assert.match(element("assistant-suggestions").textContent ?? "", /evidence-linked, not verified/);
	assert.match(element("assistant-suggestions").textContent ?? "", /sample · 10 rows.*sample only, not population/);
	assert.match(element("assistant-suggestions").textContent ?? "", /Generated code · inspect only/);
	assert.equal(document.querySelector("#assistant-suggestions img"), null);
	assert.equal(document.getElementById("assistant-apply-suggestion-one"), null);
	element("assistant-accept-suggestion-one").click();
	await waitFor(() => element("assistant-suggestion-suggestion-one").dataset.status === "accepted");
	assert.equal(element<HTMLButtonElement>("assistant-apply-suggestion-one").disabled, true);
	element("assistant-preview-suggestion-one").click();
	await waitFor(() => !element<HTMLButtonElement>("assistant-apply-suggestion-one").disabled);
	assert.ok(element("assistant-preview-canvas-suggestion-one").querySelector("svg"));
	assert.match(element("assistant-suggestions").textContent ?? "", /10 \/ 100 rows.*sample only/);
	assert.match(element("assistant-suggestions").textContent ?? "", /Bounded sample only/);
	element("assistant-apply-suggestion-one").click();
	await waitFor(() => element("assistant-suggestion-suggestion-one").dataset.status === "applied");
	assert.deepEqual(JSON.parse(String(requests.find(({ path }) => path.endsWith("/apply"))!.init.body)), {
		previewId: "preview-one",
	});
	element("assistant-open-chart-suggestion-one").click();
	assert.equal(
		element("center-panel-visualize").hidden,
		false,
		JSON.stringify({
			buttonDisabled: element<HTMLButtonElement>("assistant-open-chart-suggestion-one").disabled,
			error: element("assistant-suggestion-error").textContent,
			chart: element("chart-json-left").textContent,
		}),
	);
	assert.deepEqual(JSON.parse(element("chart-json-left").textContent!), spec);
	assert.equal(
		requests.some(({ path }) => path.endsWith("/chart-preview")),
		false,
	);
	assert.equal(
		requests.some(({ path }) => path.endsWith("/charts")),
		false,
	);
	element("assistant-revert-suggestion-one").click();
	assert.equal(
		requests.some(({ path }) => path.endsWith("/revert")),
		false,
	);
	element("assistant-keep-chart-suggestion-one").click();
	assert.equal(
		requests.some(({ path }) => path.endsWith("/revert")),
		false,
	);
	element("assistant-revert-suggestion-one").click();
	element("assistant-confirm-revert-suggestion-one").click();
	await waitFor(() => element("assistant-suggestion-suggestion-one").dataset.status === "reverted");
	assert.equal(element<HTMLSelectElement>("assistant-runs").options.length, 1);
});

test("read-only hypotheses remain inspect-only after acceptance and expose no chart application", async (t) => {
	const value = run();
	value.suggestions = [
		{
			...suggestion,
			evidenceRefs: [],
			basis: "hypothesis",
			generatedCode: hostile,
			proposedAction: {
				kind: "read-only",
				description: "Validate the meaning of failure rate before choosing a chart.",
			},
		},
	];
	const { activate, element, document, requests } = await setup(t, { history: [value] });
	await activate();
	assert.match(element("assistant-suggestions").textContent ?? "", /AI hypothesis · requires validation/);
	assert.match(element("assistant-suggestions").textContent ?? "", /No supporting references/);
	element("assistant-accept-suggestion-one").click();
	await waitFor(() => element("assistant-suggestion-suggestion-one").dataset.status === "accepted");
	assert.equal(document.getElementById("assistant-apply-suggestion-one"), null);
	assert.equal(document.getElementById("assistant-preview-suggestion-one"), null);
	assert.equal(
		requests.some(({ path }) => /\/(apply|preview)$/.test(path)),
		false,
	);
});

test("mismatched preview cannot enable Apply and leaves the accepted suggestion available to retry", async (t) => {
	const value = run();
	value.suggestions[0].status = "accepted";
	const { activate, element, requests } = await setup(t, {
		history: [value],
		respond(path) {
			if (path.endsWith("/preview"))
				return Response.json({ previewId: "wrong-preview", chart: chartResult({ ...spec, x: 0 }) });
		},
	});
	await activate();
	element("assistant-preview-suggestion-one").click();
	await waitFor(() => !element("assistant-suggestion-error").hidden);
	assert.equal(element<HTMLButtonElement>("assistant-apply-suggestion-one").disabled, true);
	assert.equal(element("assistant-suggestion-suggestion-one").dataset.status, "accepted");
	assert.equal(
		requests.some(({ path }) => path.endsWith("/apply")),
		false,
	);
});

test("late run responses cannot replace another selected run or leak across project boundaries", async (t) => {
	const pending = deferred();
	const running = run("running", "running");
	const completed = run("completed");
	completed.summary = "Selected old completed run";
	const { activate, element, change, requests } = await setup(t, {
		history: [running, completed],
		respond(path) {
			if (path.endsWith("/runs/running")) return pending.promise;
		},
	});
	await activate();
	element("assistant-check-run").click();
	await waitFor(() => requests.some(({ path }) => path.endsWith("/runs/running")));
	change("assistant-runs", "completed");
	assert.match(element("assistant-run").textContent ?? "", /Selected old completed run/);
	change("project-select", otherProject.id);
	await waitFor(
		() =>
			element("dataset-heading").textContent === otherDataset.name &&
			!element<HTMLButtonElement>("run-profile").disabled,
	);
	const poll = requests.find(({ path }) => path.endsWith("/runs/running"))!;
	assert.equal(poll.init.signal?.aborted, true);
	pending.resolve(Response.json({ ...running, receivedCharacters: 1000, summary: "Must never leak" }));
	await pause(10);
	assert.equal(element<HTMLSelectElement>("assistant-runs").options.length, 0);
	assert.doesNotMatch(element("assistant-run").textContent ?? "", /Must never leak|Selected old completed run/);
	assert.equal(
		requests.some(({ path }) => path.includes(otherProject.id) && path.includes("/assistant")),
		false,
	);
});
