import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window as TestWindow } from "happy-dom";
import type { ChartRecord, ChartResult, ChartSpec } from "../../src/chart-contracts.ts";
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
	id: "studio-project",
	ownerId: null,
	name: "Observations",
	description: "",
	createdAt: timestamp,
	updatedAt: timestamp,
	settings: { previewRowLimit: 100 },
};
const dataset: Dataset = {
	id: "studio-data",
	projectId: project.id,
	name: "observations.csv",
	originalFilename: "observations.csv",
	format: "csv",
	createdAt: timestamp,
	updatedAt: timestamp,
	byteSize: 1000,
	sha256: "a".repeat(64),
	rowCount: 1000,
	columnCount: 3,
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
		{ index: 2, name: "Region", sourceType: "VARCHAR", basicType: "text" },
	],
	columns: [
		{ index: 0, name: "Amount", inferredType: "number", emptyCount: 0, numericCount: 1000, min: 1, max: 100 },
		{ index: 1, name: hostile, inferredType: "text", emptyCount: 0, numericCount: 0, min: null, max: null },
		{ index: 2, name: "Region", inferredType: "text", emptyCount: 0, numericCount: 0, min: null, max: null },
	],
	parsing: { format: "csv", encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" },
	profileVersion: 1,
	profiledAt: timestamp,
};
const secondDataset: Dataset = { ...dataset, id: "studio-second", currentVersionId: "version-two", name: "second.csv" };
const profile: DatasetProfile = {
	profilerVersion: 1,
	datasetVersionId: dataset.currentVersionId,
	datasetVersionHash: "b".repeat(64),
	profiledAt: timestamp,
	rowCount: 1000,
	columnCount: 3,
	sourceBytes: 1000,
	storageBytes: 1000,
	estimatedMemoryBytes: 4000,
	duplicateCount: 0,
	sampling: {
		method: "systematic",
		populationRows: 1000,
		sampleSize: 100,
		stride: 10,
		approximate: true,
		byteLimited: false,
	},
	issues: [],
	limitations: [],
	columns: dataset.schema.map((column) => ({
		index: column.index,
		name: column.name,
		originalType: column.sourceType,
		semanticTypes: [
			{ type: column.index === 0 ? "numeric" : "categorical", confidence: 0.95, reason: "Observed bounded profile" },
		],
		nullCount: 0,
		nullPercentage: 0,
		emptyStringCount: 0,
		distinctCount: column.index === 1 ? 75 : 3,
		distinctPercentage: column.index === 1 ? 75 : 3,
		examples: [],
		topValues: [],
		limitations: [],
		numeric:
			column.index === 0
				? {
						count: 100,
						excludedCount: 0,
						min: 1,
						max: 100,
						mean: 50,
						median: 50,
						standardDeviation: 20,
						quantiles: { p05: 5, p25: 25, p75: 75, p95: 95 },
						skewness: 0,
						outlierCount: 0,
						lowerFence: -50,
						upperFence: 150,
						approximate: true,
					}
				: null,
	})),
};
const basePath = `/api/projects/${project.id}/datasets/${dataset.id}`;
const storageKey = `datapi.workbench.charts.v1.${project.id}.${dataset.id}`;
function result(spec: ChartSpec): ChartResult {
	return {
		spec,
		datasetVersionHash: profile.datasetVersionHash,
		generatedAt: timestamp,
		populationRows: 1000,
		sampleSize: 100,
		stride: 10,
		byteLimited: false,
		sampled: true,
		filteredRows: 3,
		excludedRows: 1,
		omittedMarks: 2,
		marks: [
			{
				x: spec.type === "histogram" || spec.type === "scatter" ? 1 : "Group",
				y: 3,
				value: 3,
				color: null,
				size: null,
				facet: null,
				low: spec.type === "histogram" ? 0 : null,
				high: spec.type === "histogram" ? 2 : null,
				q1: null,
				median: null,
				q3: null,
				rowIds: [0, 10, 90],
			},
		],
		table: {
			columns: dataset.schema.slice(0, 2),
			rows: [
				{ rowId: 0, values: ["1", hostile] },
				{ rowId: 10, values: ["2", null] },
				{ rowId: 20, values: ["3", ""] },
			],
		},
		warnings: ["Only the bounded sample is shown.", "Some categories were omitted."],
		labels: {
			x: "Amount",
			y: "Observed count",
			color: "None",
			size: "None",
			facet: "None",
			aggregation: spec.aggregation,
			filters: spec.filters.length ? "Configured literal filters" : "None",
			missing: "Null and invalid numeric values excluded",
		},
	};
}
async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Expected studio state did not settle");
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
		profile?: DatasetProfile | null;
		storage?: Record<string, string>;
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
	for (const [key, value] of Object.entries(options.storage ?? {})) browser.localStorage.setItem(key, value);
	const requests: { path: string; init: RequestInit }[] = [];
	let saved: ChartRecord[] = [];
	let nextId = 0;
	browser.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		requests.push({ path, init });
		const override = options.respond?.(path, init);
		if (override) return override;
		if (path === "/api/bootstrap")
			return Response.json({
				token: "studio-token",
				projects: [project],
				maxUploadBytes: 100_000_000,
				maxDecodedBytes: 256 * 1024 * 1024,
				maxPreviewRows: 500,
			} satisfies Bootstrap);
		if (path === `/api/projects/${project.id}/datasets`) return Response.json([dataset, secondDataset]);
		if (path === basePath) return Response.json(dataset);
		if (path.endsWith(`/datasets/${secondDataset.id}`)) return Response.json(secondDataset);
		if (path.endsWith("/profile"))
			return Response.json({
				profile:
					options.profile === null
						? null
						: {
								...(options.profile ?? profile),
								datasetVersionId: path.startsWith(basePath)
									? dataset.currentVersionId
									: secondDataset.currentVersionId,
							},
			});
		if (path.includes("/preview?"))
			return Response.json({ offset: 0, limit: 100, total: 1000, rows: [["1", "original", "west"]] });
		if (path.endsWith("/chart-preview")) return Response.json(result(JSON.parse(String(init.body)).spec));
		if (path.endsWith("/charts") && !init.method) return Response.json(saved);
		if (path.endsWith("/charts") && init.method === "POST") {
			const body = JSON.parse(String(init.body));
			const chart: ChartRecord = {
				id: `chart-${++nextId}`,
				projectId: project.id,
				datasetId: dataset.id,
				name: body.name,
				spec: body.spec,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			saved.push(chart);
			return Response.json(chart, { status: 201 });
		}
		if (path.includes("/charts/") && init.method === "PUT") {
			const body = JSON.parse(String(init.body));
			const id = path.split("/").at(-1)!;
			const chart = { ...saved.find((chart) => chart.id === id)!, ...body };
			saved = saved.map((item) => (item.id === id ? chart : item));
			return Response.json(chart);
		}
		if (path.includes("/charts/") && init.method === "DELETE") {
			saved = saved.filter((chart) => !path.endsWith(`/${chart.id}`));
			return Response.json({ deleted: true });
		}
		throw new Error(`Unexpected studio request: ${init.method ?? "GET"} ${path}`);
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
	function spec(pane = "left"): ChartSpec {
		return JSON.parse(element(`chart-json-${pane}`).textContent!);
	}
	browser.eval(script);
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	async function activate() {
		element("center-tab-visualize").click();
		await waitFor(() => requests.some(({ path }) => path.endsWith("/charts")));
	}
	return { browser, document, element, change, spec, requests, activate };
}

test("studio is lazy and missing profiles give a useful direction without additional data requests", async (t) => {
	const { element, requests, activate, document } = await setup(t, { profile: null });
	assert.equal(
		requests.some(({ path }) => path.endsWith("/charts")),
		false,
	);
	assert.equal(
		requests.some(({ path }) => path.endsWith("/chart-preview")),
		false,
	);
	await activate();
	assert.equal(element<HTMLButtonElement>("chart-render").disabled, true);
	assert.match(element("chart-studio").textContent ?? "", /current saved profile is required/);
	element("chart-profile-direction").click();
	assert.equal(document.activeElement?.id, "run-profile");
	assert.equal(requests.filter(({ init }) => init.method === "POST").length, 0);
	assert.equal(element("preview-body").querySelector("td")?.textContent, "1");
});

test("field semantics, cardinality safeguards and multiple literal filters stay explicit and safely escaped", async (t) => {
	const { element, change, spec, requests, document, activate } = await setup(t);
	await activate();
	change("chart-field-search", "high cardinality", "input");
	assert.equal(element("chart-fields").querySelectorAll("button").length, 1);
	element("chart-field-1").click();
	assert.equal(spec().x, 1);
	assert.equal(element<HTMLSelectElement>("chart-x").value, "1");
	assert.match(element("chart-safeguards").textContent ?? "", /75.*limit 20/);
	assert.equal(element("chart-fields").querySelector("img"), null);
	element("chart-add-filter").click();
	change("chart-filter-value-0", hostile, "input");
	element("chart-add-filter").click();
	change("chart-filter-column-1", "2");
	change("chart-filter-value-1", "west", "input");
	assert.equal(spec().filters.length, 2);
	assert.equal(spec().filters[0].value, hostile);
	change("chart-filter-op-0", "is-null");
	assert.equal(spec().filters[0].value, "");
	assert.equal(element<HTMLInputElement>("chart-filter-value-0").disabled, true);
	element("chart-filter-remove-0").click();
	assert.deepEqual(spec().filters, [{ column: 2, op: "eq", value: "west" }]);
	assert.equal(document.querySelector("#chart-studio img"), null);
	assert.equal(requests.filter(({ path }) => path.endsWith("/chart-preview")).length, 0);
	assert.ok(element("chart-recommendations").querySelectorAll("button").length >= 4);
	change("chart-type", "scatter");
	assert.equal(spec().aggregation, "none");
	assert.equal(element<HTMLSelectElement>("chart-aggregation").disabled, true);
	change("chart-type", "heatmap");
	assert.equal(spec().color, null);
	assert.equal(spec().size, null);
	assert.equal(element<HTMLInputElement>("chart-x-min").disabled, true);
	change("chart-aggregation", "mean");
	assert.equal(spec().size, 0);
	change("chart-type", "missingness");
	for (const key of ["x", "y", "color", "size", "facet"] as const) assert.equal(spec()[key], null);
	assert.equal(spec().aggregation, "none");
	assert.equal(spec().filters.length, 1);
});

test("comparison panes edit independently, render sequentially and report partial failures", async (t) => {
	const first = deferred();
	let renders = 0;
	const { element, change, spec, requests, activate } = await setup(t, {
		respond(path) {
			if (!path.endsWith("/chart-preview")) return;
			renders++;
			return renders === 1
				? first.promise
				: Response.json({ error: "Right chart could not render" }, { status: 409 });
		},
	});
	await activate();
	change("chart-x", "2");
	change("chart-mode", "chart-chart");
	change("chart-active-pane", "right");
	change("chart-type", "histogram");
	assert.equal(spec("left").type, "bar");
	assert.equal(spec("right").type, "histogram");
	element("chart-render").click();
	await waitFor(() => renders === 1);
	await pause(5);
	assert.equal(renders, 1);
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, true);
	const sent = JSON.parse(String(requests.find(({ path }) => path.endsWith("/chart-preview"))!.init.body)).spec;
	first.resolve(Response.json(result(sent)));
	await waitFor(() => element("chart-cancel").hidden);
	assert.equal(renders, 2);
	assert.match(element("chart-status").textContent ?? "", /1 of 2 charts rendered/);
	assert.ok(element("chart-canvas-left").querySelector("svg"));
	assert.equal(element("chart-error-right").textContent, "Right chart could not render");
	assert.equal(element<HTMLButtonElement>("chart-export-left-svg").disabled, false);
	assert.equal(element<HTMLButtonElement>("chart-export-right-svg").disabled, true);
	assert.match(element("chart-python-left").textContent ?? "", /Frozen deterministic/);
	assert.match(element("chart-metadata-left").textContent ?? "", /100 \/ 1000 rows/);
});

test("two filtered variants share encoding changes, retain independent filters and restore validated browser state", async (t) => {
	const first = await setup(t);
	await first.activate();
	first.change("chart-x", "2");
	first.change("chart-mode", "filtered");
	first.element("chart-add-filter").click();
	first.change("chart-filter-value-0", "west", "input");
	first.change("chart-active-pane", "right");
	first.element("chart-add-filter").click();
	first.change("chart-filter-value-0", "east", "input");
	first.change("chart-type", "histogram");
	assert.equal(first.spec("left").type, "histogram");
	assert.equal(first.spec("right").type, "histogram");
	assert.equal(first.spec("left").filters[0].value, "west");
	assert.equal(first.spec("right").filters[0].value, "east");
	const stored = first.browser.localStorage.getItem(storageKey)!;
	const restored = await setup(t, { storage: { [storageKey]: stored } });
	await restored.activate();
	assert.equal(restored.element<HTMLSelectElement>("chart-mode").value, "filtered");
	assert.equal(restored.element<HTMLSelectElement>("chart-active-pane").value, "right");
	assert.equal(restored.spec("left").filters[0].value, "west");
	assert.equal(restored.spec("right").filters[0].value, "east");
	assert.equal(
		restored.requests.some(({ path }) => path.endsWith("/chart-preview")),
		false,
	);
	const outdated = JSON.parse(stored);
	outdated.left.datasetVersionId = "obsolete";
	const rejected = await setup(t, { storage: { [storageKey]: JSON.stringify(outdated) } });
	await rejected.activate();
	assert.equal(rejected.spec().datasetVersionId, dataset.currentVersionId);
	assert.equal(rejected.spec().type, "bar");
	assert.equal(rejected.element("chart-storage-note").hidden, false);
});

test("cancel and dataset switches suppress late chart responses and abort their signals", async (t) => {
	const pending = deferred();
	const { element, document, requests, activate } = await setup(t, {
		respond(path) {
			if (path.endsWith("/chart-preview")) return pending.promise;
		},
	});
	await activate();
	element("chart-render").click();
	await waitFor(() => requests.some(({ path }) => path.endsWith("/chart-preview")));
	const request = requests.find(({ path }) => path.endsWith("/chart-preview"))!;
	element("chart-cancel").click();
	assert.equal(request.init.signal?.aborted, true);
	assert.equal(element("chart-cancel").hidden, true);
	document.querySelector<HTMLButtonElement>(`[data-dataset-id="${secondDataset.id}"]`)!.click();
	await waitFor(
		() =>
			element("dataset-heading").textContent === secondDataset.name &&
			!element<HTMLButtonElement>("run-profile").disabled,
	);
	pending.resolve(Response.json(result(JSON.parse(String(request.init.body)).spec)));
	await pause(10);
	assert.equal(element("chart-canvas-left").querySelector("svg"), null);
	assert.doesNotMatch(element("chart-python-left").textContent ?? "", /version-one/);
	assert.match(element("chart-json-left").textContent ?? "", /version-two/);
});

test("saved configurations support intentional create, update, rename, duplicate and confirmed delete", async (t) => {
	const { element, change, requests, activate } = await setup(t);
	await activate();
	change("chart-name", hostile, "input");
	element("chart-save-new").click();
	await waitFor(() => element<HTMLSelectElement>("chart-saved-list").value === "chart-1");
	change("chart-x", "2");
	element("chart-save-update").click();
	await waitFor(() => requests.some(({ path, init }) => path.endsWith("/charts/chart-1") && init.method === "PUT"));
	await waitFor(() => !element<HTMLButtonElement>("chart-rename").disabled);
	change("chart-name", "Renamed", "input");
	element("chart-rename").click();
	await waitFor(() => element<HTMLSelectElement>("chart-saved-list").selectedOptions[0]?.textContent === "Renamed");
	element("chart-duplicate").click();
	await waitFor(() => element<HTMLSelectElement>("chart-saved-list").value === "chart-2");
	assert.equal(element<HTMLSelectElement>("chart-saved-list").selectedOptions[0]?.textContent, "Renamed (copy)");
	element("chart-delete").click();
	assert.equal(
		requests.some(({ init }) => init.method === "DELETE"),
		false,
	);
	element("chart-dismiss-delete").click();
	assert.equal(
		requests.some(({ init }) => init.method === "DELETE"),
		false,
	);
	element("chart-delete").click();
	element("chart-confirm-delete").click();
	await waitFor(() => element<HTMLSelectElement>("chart-saved-list").value === "");
	assert.equal(requests.filter(({ init }) => init.method === "DELETE").length, 1);
	assert.equal(requests.filter(({ init }) => init.method === "POST").length, 2);
	assert.equal(element("chart-studio").querySelector("img"), null);
	assert.ok(
		requests
			.filter(({ path }) => path.includes("/charts"))
			.every(({ init }) => new Headers(init.headers).get("X-Workbench-Token") === "studio-token"),
	);
});

test("saved earlier-version configurations are not silently retargeted", async (t) => {
	const stale: ChartRecord = {
		id: "old-chart",
		projectId: project.id,
		datasetId: dataset.id,
		name: "Earlier chart",
		createdAt: timestamp,
		updatedAt: timestamp,
		spec: defaultChartSpec("earlier-version"),
	};
	const { activate, element, change, spec } = await setup(t, {
		respond(path, init) {
			if (path.endsWith("/charts") && !init.method) return Response.json([stale]);
		},
	});
	await activate();
	await waitFor(() => element<HTMLSelectElement>("chart-saved-list").options.length === 2);
	change("chart-saved-list", stale.id);
	element("chart-load").click();
	assert.match(element("chart-saved-error").textContent ?? "", /not been retargeted/);
	assert.equal(spec().datasetVersionId, dataset.currentVersionId);
});

test("linked selection uses original row IDs with keyboard marks and bounded accessible source table", async (t) => {
	const { activate, element, change, browser, document } = await setup(t);
	await activate();
	change("chart-mode", "data-chart");
	element("chart-render").click();
	await waitFor(() => Boolean(element("chart-canvas-left").querySelector("svg")) && element("chart-cancel").hidden);
	const mark = element("chart-canvas-left").querySelector<SVGElement>(".chart-mark[role='button']")!;
	assert.ok(mark);
	mark.dispatchEvent(
		new browser.KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		}) as unknown as KeyboardEvent,
	);
	assert.match(
		element("chart-selection-status").textContent ?? "",
		/3 selected source rows; 2 of 3 visible rows highlighted/,
	);
	assert.equal(element("chart-table-scroll").querySelectorAll('[data-highlighted="true"]').length, 2);
	assert.equal(element("chart-table-scroll").tabIndex, 0);
	assert.equal(element("chart-table-scroll").getAttribute("role"), "region");
	assert.equal(element("chart-table-scroll").querySelector('[data-row-id="10"] th')?.textContent, "11 · selected");
	assert.equal(document.querySelector("#chart-table-scroll img"), null);
	element("chart-clear-selection").click();
	assert.equal(element("chart-table-scroll").querySelectorAll('[data-highlighted="true"]').length, 0);
	assert.equal(element("chart-canvas-left").querySelector('[aria-pressed="true"]'), null);
});

test("frozen JSON, SVG and HTML downloads revoke object URLs and edits invalidate stale exports", async (t) => {
	const { activate, element, browser, change } = await setup(t);
	await activate();
	const urls: string[] = [];
	const revoked: string[] = [];
	const blobs: Blob[] = [];
	browser.URL.createObjectURL = ((blob: Blob) => {
		blobs.push(blob);
		const url = `blob:studio-${blobs.length}`;
		urls.push(url);
		return url;
	}) as typeof browser.URL.createObjectURL;
	browser.URL.revokeObjectURL = (url: string) => {
		revoked.push(url);
	};
	browser.HTMLAnchorElement.prototype.click = () => {};
	element("chart-render").click();
	await waitFor(() => !element<HTMLButtonElement>("chart-export-left-json").disabled);
	for (const format of ["json", "svg", "html"]) {
		element(`chart-export-left-${format}`).click();
		await waitFor(() => blobs.length === ["json", "svg", "html"].indexOf(format) + 1);
		await waitFor(() => !element<HTMLButtonElement>(`chart-export-left-${format}`).disabled);
	}
	await waitFor(() => revoked.length === 3);
	assert.deepEqual(revoked, urls);
	assert.match(await blobs[0].text(), /version-one/);
	assert.match(await blobs[1].text(), /<svg/);
	assert.match(await blobs[2].text(), /<html/i);
	change("chart-x", "2");
	assert.equal(element<HTMLButtonElement>("chart-export-left-json").disabled, true);
});
