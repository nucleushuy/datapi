import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window as TestWindow } from "happy-dom";
import type { Bootstrap, Dataset, ImportJob, Project } from "../../src/contracts.ts";
import { type DatasetProfile, PROFILER_VERSION } from "../../src/profile-contracts.ts";

const html = await readFile(new URL("../../src/browser/index.html", import.meta.url), "utf8");
const bundle = await build({
	entryPoints: [fileURLToPath(new URL("../../src/browser/app.ts", import.meta.url))],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
});
const script = bundle.outputFiles[0].text;
const timestamp = "2026-09-23T12:00:00.000Z";
const maliciousName = '<img src=x onerror="alert(1)">';
const project: Project = {
	id: "project-one",
	ownerId: null,
	name: "Observations",
	description: "Source records",
	createdAt: timestamp,
	updatedAt: timestamp,
	settings: { previewRowLimit: 100 },
};
const dataset: Dataset = {
	id: "dataset-one",
	projectId: project.id,
	name: "measurements.parquet",
	originalFilename: "measurements.parquet",
	format: "parquet",
	createdAt: timestamp,
	updatedAt: timestamp,
	byteSize: 2048,
	sha256: "a".repeat(64),
	rowCount: 100,
	columnCount: 2,
	ingestionStatus: "ready",
	schemaVersion: 2,
	storageLocation: "source.parquet",
	sourceVersionId: "source-one",
	currentVersionId: "derived-one",
	versions: [
		{
			id: "derived-one",
			kind: "derived",
			parentVersionId: "source-one",
			storageLocation: "data.parquet",
			createdAt: timestamp,
			operation: { kind: "ingest", engine: "duckdb", version: "1" },
		},
	],
	schema: [
		{ index: 0, name: "measurement", sourceType: "DOUBLE", basicType: "number" },
		{ index: 1, name: maliciousName, sourceType: "VARCHAR", basicType: "text" },
	],
	columns: [
		{ index: 0, name: "measurement", inferredType: "number", emptyCount: 1, numericCount: 99, min: 1, max: 8 },
		{ index: 1, name: maliciousName, inferredType: "text", emptyCount: 0, numericCount: 0, min: null, max: null },
	],
	parsing: { format: "parquet", emptyValues: "null", valueEncoding: "duckdb-text" },
	profileVersion: 1,
	profiledAt: timestamp,
};
const secondDataset: Dataset = {
	...dataset,
	id: "dataset-two",
	name: "second.parquet",
	currentVersionId: "derived-two",
	schema: [
		{ index: 0, name: "second measurement", sourceType: "DOUBLE", basicType: "number" },
		{ index: 1, name: "second category", sourceType: "VARCHAR", basicType: "text" },
	],
};
const profile: DatasetProfile = {
	profilerVersion: PROFILER_VERSION,
	datasetVersionId: dataset.currentVersionId,
	datasetVersionHash: "b".repeat(64),
	profiledAt: timestamp,
	rowCount: 100,
	columnCount: 2,
	sourceBytes: 2048,
	storageBytes: 4096,
	estimatedMemoryBytes: 10000,
	duplicateCount: 2,
	sampling: {
		method: "systematic",
		populationRows: 100,
		sampleSize: 10,
		stride: 10,
		byteLimited: false,
		approximate: true,
	},
	columns: [
		{
			index: 0,
			name: "measurement",
			originalType: "DOUBLE",
			semanticTypes: [{ type: "numeric", confidence: 0.97, reason: "Finite numeric subset" }],
			nullCount: 1,
			nullPercentage: 10,
			emptyStringCount: 0,
			distinctCount: 8,
			distinctPercentage: (8 / 9) * 100,
			examples: ["[numeric]"],
			topValues: [{ label: "[numeric group 1]", count: 2 }],
			numeric: {
				count: 9,
				excludedCount: 1,
				min: 1,
				max: 8,
				mean: 4.5,
				median: 4,
				standardDeviation: 2,
				quantiles: { p05: 1.4, p25: 2, p75: 6, p95: 7.6 },
				skewness: 0.25,
				outlierCount: 1,
				lowerFence: -4,
				upperFence: 12,
				approximate: true,
			},
			limitations: ["Numeric arithmetic uses floating point."],
		},
		{
			index: 1,
			name: maliciousName,
			originalType: "VARCHAR",
			semanticTypes: [{ type: "categorical", confidence: 0.8, reason: "Repeated values" }],
			nullCount: 0,
			nullPercentage: 0,
			emptyStringCount: 1,
			distinctCount: 2,
			distinctPercentage: 20,
			examples: ["[redacted text]"],
			topValues: [{ label: "[category 1]", count: 8 }],
			numeric: null,
			limitations: [],
		},
	],
	issues: [
		{
			id: "missing-0",
			kind: "missing",
			severity: "warning",
			columns: [0],
			title: "Missing measurements",
			confidence: 0.9,
			evidence: [
				{
					metric: "nullCount",
					value: 1,
					basis: "sample",
					rows: 10,
					approximate: false,
					detail: "One null in the inspected rows",
				},
			],
			proposedAction: "Review missingness before choosing an imputation strategy.",
		},
		{
			id: "constant-1",
			kind: "constant",
			severity: "info",
			columns: [1],
			title: maliciousName,
			confidence: 0.75,
			evidence: [
				{
					metric: "correlation",
					value: 0.9876543210123,
					basis: "sample",
					rows: 9,
					approximate: true,
					detail: "Floating point heuristic",
				},
			],
			proposedAction: "Review the original column before removing it.",
		},
	],
	limitations: ["Systematic samples can miss periodic patterns.", "No changes were made to source data."],
};
const profileUrl = `/api/projects/${project.id}/datasets/${dataset.id}/profile`;
const job: ImportJob = {
	id: "profile-job",
	projectId: project.id,
	datasetId: dataset.id,
	name: dataset.name,
	format: "parquet",
	kind: "profile",
	state: "processing",
	createdAt: timestamp,
	updatedAt: timestamp,
	bytesReceived: 0,
	bytesProcessed: 128,
	rowCount: 5,
};
const jobUrl = `/api/projects/${project.id}/imports/${job.id}`;

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Expected browser state did not settle");
		await pause(1);
	}
}

function deferredResponse() {
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
	browser.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		requests.push({ path, init });
		const response = options.respond?.(path, init);
		if (response) return response;
		if (path === "/api/bootstrap")
			return Response.json({
				token: "test-token",
				projects: [project],
				maxUploadBytes: 100_000_000,
				maxDecodedBytes: 256 * 1024 * 1024,
				maxPreviewRows: 500,
			} satisfies Bootstrap);
		if (path === `/api/projects/${project.id}/datasets`) return Response.json([dataset, secondDataset]);
		if (path.endsWith(`/datasets/${dataset.id}`)) return Response.json(dataset);
		if (path.endsWith(`/datasets/${secondDataset.id}`)) return Response.json(secondDataset);
		if (path === profileUrl) return Response.json({ profile: options.profile ?? null });
		if (path.endsWith(`/datasets/${secondDataset.id}/profile`)) return Response.json({ profile: null });
		if (path.includes("/preview?"))
			return Response.json({
				offset: 0,
				limit: 100,
				total: 100,
				rows: [
					["1", "original cell"],
					[null, ""],
				],
			});
		throw new Error(`Unexpected browser request: ${init.method ?? "GET"} ${path}`);
	}) as unknown as typeof browser.fetch;
	const document = browser.document as unknown as Document;
	function element<T extends HTMLElement = HTMLElement>(id: string): T {
		const value = document.getElementById(id);
		assert.ok(value, id);
		return value as T;
	}
	function input(id: string, value: string, event = "input") {
		element<HTMLInputElement>(id).value = value;
		element(id).dispatchEvent(new browser.Event(event, { bubbles: true }) as unknown as Event);
	}
	function key(id: string, key: string) {
		element(id).dispatchEvent(
			new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as KeyboardEvent,
		);
	}
	browser.eval(script);
	await waitFor(() => !element<HTMLButtonElement>("import-button").disabled);
	return { browser, document, element, input, key, requests };
}

test("rich profiles remain optional while source preview and ingestion statistics work", async (t) => {
	const { element, requests } = await setup(t);
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	assert.match(element("rich-profile-status").textContent ?? "", /No rich profile loaded/);
	assert.equal(element("statistics-rich").hidden, true);
	assert.equal(element("profile-overview").querySelectorAll(".overview-card").length, 3);
	assert.doesNotMatch(element("profile-overview").textContent ?? "", /Duplicate|Estimated memory/);
	assert.equal(element("preview-body").querySelector("td")?.textContent, "1");
	assert.equal(element("profile-body").querySelectorAll("tr").length, 2);
	element("view-quality").click();
	assert.equal(element("quality-panel").hidden, false);
	assert.match(element("quality-summary").textContent ?? "", /Run profile explicitly/);
	assert.equal(requests.filter(({ init }) => init.method === "POST").length, 0);
});

test("saved-profile loading and retryable errors never remove original data", async (t) => {
	const pending = deferredResponse();
	let first = true;
	const { element } = await setup(t, {
		respond(path) {
			if (path !== profileUrl) return;
			if (first) {
				first = false;
				return pending.promise;
			}
			return Response.json({ profile });
		},
	});
	assert.match(element("rich-profile-status").textContent ?? "", /Loading saved profile/);
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, true);
	assert.equal(element("preview-scroll").hidden, false);
	pending.resolve(Response.json({ error: "Profile cache unavailable" }, { status: 503 }));
	await waitFor(() => !element("rich-profile-error").hidden);
	assert.equal(element("rich-profile-error").textContent, "Profile cache unavailable");
	assert.equal(element("retry-profile").hidden, false);
	assert.equal(element("preview-scroll").hidden, false);
	element("retry-profile").click();
	await waitFor(() => !element("statistics-rich").hidden);
	assert.equal(element("rich-profile-error").hidden, true);
});

test("search and keyboard selection inspect a real column beside original rows with safe text", async (t) => {
	const { element, document, browser, input, key } = await setup(t, { profile });
	await waitFor(() => !element("statistics-rich").hidden);
	const rows = element("preview-body").textContent;
	input("column-search", "categorical");
	assert.equal(element("column-list").querySelectorAll("button").length, 1);
	key("column-search", "Enter");
	assert.equal(element("column-details").querySelector("h3")?.textContent, maliciousName);
	assert.equal(document.activeElement?.getAttribute("aria-pressed"), "true");
	assert.equal(element("preview-panel").hidden, false);
	assert.equal(element("preview-body").textContent, rows);
	assert.equal(
		element("column-details").closest(".preview-profile-layout")?.querySelector("#preview-table"),
		element("preview-table"),
	);
	assert.equal(
		document.querySelector("#column-list img, #column-details img, #statistics-body img, #quality-issues img"),
		null,
	);
	assert.match(element("column-details").textContent ?? "", /\[redacted text\]/);
	input("column-search", "no such column");
	assert.equal(element("column-list").querySelectorAll("button").length, 0);
	assert.match(element("column-search-status").textContent ?? "", /No matching columns/);
	key("column-search", "Escape");
	assert.equal(element("column-list").querySelectorAll("button").length, 2);
	key("column-search", "ArrowDown");
	document.activeElement?.dispatchEvent(
		new browser.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }) as unknown as KeyboardEvent,
	);
	assert.equal(element("column-details").querySelector("h3")?.textContent, maliciousName);
	element("view-profile").click();
	input("statistics-column", "0", "change");
	element("inspect-column").click();
	assert.equal(element("center-panel-data").hidden, false);
	assert.equal(document.activeElement?.id, "column-details");
	assert.equal(element("column-details").querySelector("h3")?.textContent, "measurement");
});

test("sample counts, memory estimates and every numeric metric carry their basis", async (t) => {
	const { element } = await setup(t, { profile });
	await waitFor(() => !element("statistics-rich").hidden);
	assert.match(element("profile-overview").textContent ?? "", /sample rows, not population/);
	assert.match(element("profile-overview").textContent ?? "", /Estimated memory≈/);
	assert.match(element("profile-sampling").textContent ?? "", /Sample only · 10 of 100 population rows/);
	assert.match(element("profile-sampling").textContent ?? "", /stride 10/);
	assert.match(element("profile-limitations").textContent ?? "", /periodic patterns/);
	const details = element("statistics-details").textContent ?? "";
	for (const text of [
		"Nulls1 / 10",
		"Distinct values8",
		"Mean≈ 4.5",
		"Median (50%)≈ 4",
		"Standard deviation≈ 2",
		"5% quantile≈ 1.4",
		"25% quantile≈ 2",
		"75% quantile≈ 6",
		"95% quantile≈ 7.6",
		"Skewness≈ 0.25",
		"Outlier candidates1",
		"Lower fence≈ -4",
		"Upper fence≈ 12",
	])
		assert.ok(details.includes(text), text);
	assert.match(details, /Floating-point approximations/);
	assert.match(details, /Frequencies observed in 10 sample rows, not population/);
});

test("full scans still label numeric floating arithmetic and estimated memory approximate", async (t) => {
	const { element } = await setup(t, {
		profile: {
			...profile,
			rowCount: 10,
			sampling: {
				method: "full",
				populationRows: 10,
				sampleSize: 10,
				stride: 1,
				byteLimited: false,
				approximate: false,
			},
		},
	});
	await waitFor(() => !element("statistics-rich").hidden);
	assert.match(element("statistics-details").textContent ?? "", /Full scan · 10 rows/);
	assert.match(element("statistics-details").textContent ?? "", /Minimum≈ 1/);
	assert.match(element("statistics-details").textContent ?? "", /even on a full scan/);
	assert.match(element("profile-overview").textContent ?? "", /Approximate even on a full scan/);
});

test("quality severity filters preserve exact reported evidence and proposed action", async (t) => {
	const { element, input } = await setup(t, { profile });
	await waitFor(() => !element("statistics-rich").hidden);
	element("view-quality").click();
	assert.equal(element("statistics-panel").hidden, true);
	assert.equal(element("quality-panel").hidden, false);
	assert.equal(element("quality-issues").children.length, 2);
	assert.match(element("quality-issues").textContent ?? "", /0\.9876543210123/);
	input("quality-severity", "warning", "change");
	assert.equal(element("quality-issues").children.length, 1);
	const evidence = element("quality-issues").textContent ?? "";
	assert.match(evidence, /nullCount/);
	assert.match(evidence, /sample · 10 rows/);
	assert.match(evidence, /exact within sample only, not population/);
	assert.match(evidence, /One null in the inspected rows/);
	assert.match(evidence, /Confidence0.9/);
	assert.match(evidence, /Review missingness before choosing an imputation strategy/);
	input("quality-severity", "error", "change");
	assert.equal(element("quality-issues").children.length, 0);
	assert.match(element("quality-summary").textContent ?? "", /No findings match this severity/);
});

test("explicit profile job reuses imports progress and cancellation without hiding data", async (t) => {
	const { element, requests } = await setup(t, {
		respond(path, init) {
			if (path === profileUrl && init.method === "POST") return Response.json(job);
			if (path === jobUrl)
				return Response.json({ ...job, state: init.method === "DELETE" ? "cancelled" : "processing" });
		},
	});
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	element("run-profile").click();
	await waitFor(() => element("operation-state").textContent === "Processing");
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, true);
	assert.equal(element("operation-progress").hasAttribute("value"), false);
	assert.match(element("operation-detail").textContent ?? "", /5 rows processed/);
	assert.equal(element("preview-scroll").hidden, false);
	element("cancel-operation").click();
	await waitFor(() => element("operation-state").textContent === "Cancelled");
	assert.ok(requests.some(({ path, init }) => path === jobUrl && init.method === "DELETE"));
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, false);
	assert.equal(element("statistics-rich").hidden, true);
	assert.equal(element("preview-scroll").hidden, false);
});

test("completed cache hits fetch the saved report without importing or changing selection", async (t) => {
	let completed = false;
	const { element, requests } = await setup(t, {
		respond(path, init) {
			if (path !== profileUrl) return;
			if (init.method === "POST") {
				completed = true;
				return Response.json({ ...job, state: "completed" });
			}
			return Response.json({ profile: completed ? profile : null });
		},
	});
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	element("run-profile").click();
	await waitFor(() => !element("statistics-rich").hidden);
	assert.match(element("rich-profile-status").textContent ?? "", /Saved profile/);
	assert.match(element("operation-detail").textContent ?? "", /cache is reused/);
	assert.equal(element("dataset-heading").textContent, dataset.name);
	assert.equal(requests.filter(({ path }) => path.endsWith(`/datasets/${dataset.id}`)).length, 1);
	assert.equal(requests.filter(({ init }) => init.method === "POST").length, 1);
});

test("profile POST failures allow another explicit run while preserving the saved report", async (t) => {
	const { element } = await setup(t, {
		profile,
		respond(path, init) {
			if (path === profileUrl && init.method === "POST")
				return Response.json({ error: "Profiler temporarily unavailable" }, { status: 503 });
		},
	});
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	element("run-profile").click();
	await waitFor(() => element("operation-state").textContent === "Failed");
	assert.equal(element("operation-error").textContent, "Profiler temporarily unavailable");
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, false);
	assert.equal(element("statistics-rich").hidden, false);
	assert.match(element("operation-detail").textContent ?? "", /Use Run profile to try again/);
});

test("late saved profile responses cannot leak across dataset switches", async (t) => {
	const pending = deferredResponse();
	const { element, document } = await setup(t, {
		respond(path) {
			if (path === profileUrl) return pending.promise;
		},
	});
	document.querySelector<HTMLButtonElement>(`[data-dataset-id="${secondDataset.id}"]`)?.click();
	await waitFor(
		() =>
			element("dataset-heading").textContent === secondDataset.name &&
			!element<HTMLButtonElement>("run-profile").disabled,
	);
	pending.resolve(Response.json({ profile }));
	await pause(10);
	assert.equal(element("statistics-rich").hidden, true);
	assert.equal(element("statistics-dataset-name").textContent, secondDataset.name);
	assert.doesNotMatch(element("column-details").textContent ?? "", /Mean|measurement.*Sample only/s);
	assert.equal(element("column-details").querySelector("h3")?.textContent, "second measurement");
	assert.equal(element("quality-issues").children.length, 0);
});

test("late profile job completion never switches back to the job's dataset", async (t) => {
	const pending = deferredResponse();
	const { element, document, requests } = await setup(t, {
		respond(path, init) {
			if (path === profileUrl && init.method === "POST") return pending.promise;
		},
	});
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	element("run-profile").click();
	document.querySelector<HTMLButtonElement>(`[data-dataset-id="${secondDataset.id}"]`)?.click();
	await waitFor(() => element("dataset-heading").textContent === secondDataset.name);
	pending.resolve(Response.json({ ...job, state: "completed" }));
	await waitFor(() => element("operation-state").textContent === "Complete");
	assert.equal(element("dataset-heading").textContent, secondDataset.name);
	assert.equal(element("statistics-rich").hidden, true);
	assert.equal(requests.filter(({ path }) => path === profileUrl).length, 2);
});

test("background profile polling pauses on errors and Check status recovers the result", async (t) => {
	let completed = false;
	let checks = 0;
	const { element, requests } = await setup(t, {
		respond(path, init) {
			if (path === profileUrl && init.method === "POST") return Response.json(job);
			if (path === profileUrl) return Response.json({ profile: completed ? profile : null });
			if (path === jobUrl) {
				checks++;
				if (checks === 1) return Response.json({ error: "Status temporarily unavailable" }, { status: 503 });
				completed = true;
				return Response.json({ ...job, state: "completed" });
			}
		},
	});
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	element("run-profile").click();
	await waitFor(() => !element("retry-operation").hidden);
	assert.equal(element("operation-state").textContent, "Status unavailable");
	assert.match(element("operation-error").textContent ?? "", /Progress monitoring is paused/);
	assert.equal(element("preview-scroll").hidden, false);
	element("retry-operation").click();
	await waitFor(() => !element("statistics-rich").hidden);
	assert.equal(element("operation-state").textContent, "Complete");
	assert.equal(checks, 2);
	assert.ok(
		requests
			.filter(({ path }) => path === jobUrl)
			.every(({ init }) => new Headers(init.headers).get("X-Workbench-Token") === "test-token"),
	);
});

test("a cached report for another dataset version is rejected instead of displayed", async (t) => {
	const { element } = await setup(t, { profile: { ...profile, datasetVersionId: "obsolete-version" } });
	await waitFor(() => !element("rich-profile-error").hidden);
	assert.match(element("rich-profile-error").textContent ?? "", /does not match this dataset version/);
	assert.equal(element("statistics-rich").hidden, true);
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, false);
});

test("initial preview finishes before saved profile lookup takes analytical admission", async (t) => {
	const pendingProfile = deferredResponse();
	let profileReadActive = false;
	let rejectedPreviews = 0;
	const { element, requests } = await setup(t, {
		respond(path) {
			if (path === profileUrl) {
				profileReadActive = true;
				return pendingProfile.promise.finally(() => {
					profileReadActive = false;
				});
			}
			if (path.includes("/preview?") && profileReadActive) {
				rejectedPreviews++;
				return Response.json({ error: "Another analytical operation is active" }, { status: 409 });
			}
		},
	});
	assert.equal(rejectedPreviews, 0);
	assert.equal(element("preview-scroll").hidden, false);
	assert.equal(element("preview-body").querySelector("td")?.textContent, "1");
	assert.equal(element("retry-preview").hidden, true);
	assert.ok(
		requests.findIndex(({ path }) => path.includes("/preview?")) <
			requests.findIndex(({ path }) => path === profileUrl),
	);
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, true);
	pendingProfile.resolve(Response.json({ profile }));
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	assert.equal(element("statistics-rich").hidden, false);
});

test("dataset switches block Run profile until initial preview settles and ignore stale preview continuations", async (t) => {
	const pendingPreview = deferredResponse();
	const secondPath = `/api/projects/${project.id}/datasets/${secondDataset.id}`;
	const { element, document, requests } = await setup(t, {
		respond(path) {
			if (path.startsWith(`${secondPath}/preview?`)) return pendingPreview.promise;
		},
	});
	await waitFor(() => !element<HTMLButtonElement>("run-profile").disabled);
	document.querySelector<HTMLButtonElement>(`[data-dataset-id="${secondDataset.id}"]`)?.click();
	await waitFor(
		() =>
			element("dataset-heading").textContent === secondDataset.name &&
			element("preview-panel").getAttribute("aria-busy") === "true",
	);
	assert.equal(element<HTMLButtonElement>("run-profile").disabled, true);
	element("run-profile").click();
	assert.equal(
		requests.some(({ init }) => init.method === "POST"),
		false,
	);
	assert.equal(
		requests.some(({ path }) => path === `${secondPath}/profile`),
		false,
	);
	document.querySelector<HTMLButtonElement>(`[data-dataset-id="${dataset.id}"]`)?.click();
	await waitFor(
		() =>
			element("dataset-heading").textContent === dataset.name && !element<HTMLButtonElement>("run-profile").disabled,
	);
	const profileReads = requests.filter(({ path }) => path === profileUrl).length;
	pendingPreview.resolve(Response.json({ offset: 0, limit: 100, total: 100, rows: [["stale", "row"]] }));
	await pause(10);
	assert.equal(requests.filter(({ path }) => path === profileUrl).length, profileReads);
	assert.equal(
		requests.some(({ path }) => path === `${secondPath}/profile`),
		false,
	);
	assert.equal(element("preview-body").querySelector("td")?.textContent, "1");
	assert.equal(element("dataset-heading").textContent, dataset.name);
});
