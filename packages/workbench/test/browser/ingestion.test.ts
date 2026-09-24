import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window as TestWindow } from "happy-dom";
import type { Bootstrap, Dataset, ImportJob, Preview, Project } from "../../src/contracts.ts";

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
	name: "observations.parquet",
	originalFilename: "observations.parquet",
	format: "parquet",
	createdAt: timestamp,
	updatedAt: timestamp,
	byteSize: 128,
	sha256: "a".repeat(64),
	rowCount: 5,
	columnCount: 1,
	ingestionStatus: "ready",
	schemaVersion: 2,
	storageLocation: "source.parquet",
	sourceVersionId: "source-one",
	currentVersionId: "derived-one",
	versions: [
		{
			id: "source-one",
			kind: "source",
			parentVersionId: null,
			storageLocation: "source.parquet",
			createdAt: timestamp,
			operation: { kind: "upload", engine: "workbench", version: "1" },
		},
		{
			id: "derived-one",
			kind: "derived",
			parentVersionId: "source-one",
			storageLocation: "data.parquet",
			createdAt: timestamp,
			operation: { kind: "ingest", engine: "duckdb", version: "1" },
		},
	],
	schema: [{ index: 0, name: "value", sourceType: "VARCHAR", basicType: "text" }],
	columns: [{ index: 0, name: "value", inferredType: "text", emptyCount: 1, numericCount: 0, min: null, max: null }],
	parsing: { format: "parquet", emptyValues: "null", valueEncoding: "duckdb-text" },
	profileVersion: 1,
	profiledAt: timestamp,
};
const values = [["9007199254740993"], [null], [""], [" 001\n"], ["<script>not executable</script>"]];
const importsUrl = `/api/projects/${project.id}/imports`;

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Expected browser state did not settle");
		await pause(1);
	}
}

async function setup(
	t: TestContext,
	options: {
		maxPreviewRows?: number;
		preferredRows?: number;
		job?: ImportJob;
		respond?: (path: string, init: RequestInit) => Response | undefined;
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
	if (options.job)
		browser.sessionStorage.setItem(
			"datapi.workbench.operation",
			JSON.stringify({
				id: options.job.id,
				projectId: project.id,
				totalBytes: 128,
			}),
		);
	const requests: { path: string; init: RequestInit }[] = [];
	browser.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		requests.push({ path, init });
		const response = options.respond?.(path, init);
		if (response) return response;
		if (path === "/api/bootstrap")
			return Response.json({
				token: "test-token",
				projects: [{ ...project, settings: { previewRowLimit: options.preferredRows ?? 100 } }],
				maxUploadBytes: 100_000_000,
				maxDecodedBytes: 256 * 1024 * 1024,
				maxPreviewRows: options.maxPreviewRows ?? 500,
			} satisfies Bootstrap);
		if (/^\/api\/projects\/[^/]+\/datasets$/.test(path)) return Response.json([dataset]);
		if (path.endsWith(`/datasets/${dataset.id}`)) return Response.json(dataset);
		if (path.endsWith("/profile")) return Response.json({ profile: null });
		if (path.includes("/preview?")) {
			const url = new URL(path, browser.location.href);
			const offset = Number(url.searchParams.get("offset"));
			const limit = Number(url.searchParams.get("limit"));
			return Response.json({
				offset,
				limit,
				total: values.length,
				rows: values.slice(offset, offset + 2),
			} satisfies Preview);
		}
		if (options.job && path === `${importsUrl}/${options.job.id}`) return Response.json(options.job);
		throw new Error(`Unexpected browser request: ${init.method ?? "GET"} ${path}`);
	}) as unknown as typeof browser.fetch;
	const document = browser.document as unknown as Document;
	function element<T extends HTMLElement = HTMLElement>(id: string): T {
		const value = document.getElementById(id);
		assert.ok(value, id);
		return value as T;
	}
	function change(id: string) {
		element(id).dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
	}
	function choose(id: string, file: InstanceType<typeof browser.File>) {
		const transfer = new browser.DataTransfer();
		transfer.items.add(file);
		element<HTMLInputElement>(id).files = transfer.files as unknown as FileList;
		change(id);
	}
	browser.eval(script);
	await waitFor(() => !element<HTMLButtonElement>("import-button").disabled);
	return { browser, document, element, change, choose, requests };
}

test("preview choices honor small bootstrap caps and exact project preferences after form reset", async (t) => {
	let created: { name: string; description: string; settings: { previewRowLimit: number } } | undefined;
	const { element, browser, requests } = await setup(t, {
		maxPreviewRows: 10,
		preferredRows: 7,
		respond(path, init) {
			if (path !== "/api/projects" || init.method !== "POST") return;
			created = JSON.parse(String(init.body));
			return Response.json({ ...project, ...created, id: "project-two" });
		},
	});
	assert.equal(element<HTMLSelectElement>("preview-limit").value, "7");
	for (const id of ["preview-limit", "project-preview-limit"]) {
		const select = element<HTMLSelectElement>(id);
		assert.ok(select.value);
		assert.ok([...select.options].every((option) => Number(option.value) <= 10));
	}
	assert.ok(requests.some(({ path }) => path.endsWith("/preview?offset=0&limit=7")));
	element<HTMLInputElement>("project-name").value = "New observations";
	element<HTMLTextAreaElement>("project-description-input").value = "  A local investigation  ";
	element("project-form").dispatchEvent(
		new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
	);
	await waitFor(
		() =>
			element("project-heading").textContent === "New observations" &&
			!element<HTMLButtonElement>("create-project").disabled,
	);
	assert.deepEqual(created, {
		name: "New observations",
		description: "A local investigation",
		settings: { previewRowLimit: 10 },
	});
	assert.equal(element<HTMLSelectElement>("project-preview-limit").value, "10");
	assert.equal(element<HTMLSelectElement>("preview-limit").value, "10");
});

test("short preview pages navigate by returned rows and preserve the loaded page when a request fails", async (t) => {
	let failNext = true;
	const { element, requests, document } = await setup(t, {
		respond(path) {
			if (path.includes("/preview?offset=2&") && failNext) {
				failNext = false;
				return Response.json({ error: "Preview temporarily unavailable" }, { status: 503 });
			}
		},
	});
	assert.equal(element("preview-body").querySelector("td")?.textContent, "9007199254740993");
	assert.equal(element("preview-body").querySelectorAll("td")[1].getAttribute("aria-label"), "Null (missing value)");
	assert.equal(element("page-limit-note").hidden, false);
	assert.match(element("page-limit-note").textContent ?? "", /including metadata/);
	const previousRows = element("preview-body").textContent;
	const previousSummary = element("page-summary").textContent;
	element("next-page").click();
	await waitFor(() => !element("retry-preview").hidden);
	assert.equal(element("preview-scroll").hidden, false);
	assert.equal(element("preview-body").textContent, previousRows);
	assert.equal(element("page-summary").textContent, previousSummary);
	assert.equal(element<HTMLButtonElement>("previous-page").disabled, true);
	assert.match(element("preview-status").textContent ?? "", /previously loaded page is still shown/);
	element("retry-preview").click();
	await waitFor(() => element("page-summary").textContent?.startsWith("Rows 3–4") === true);
	assert.equal(element("preview-body").querySelector("td")?.getAttribute("aria-label"), "Empty string");
	assert.equal(element("preview-body").querySelectorAll("td")[1].textContent, " 001\n");
	element("previous-page").click();
	await waitFor(() => element("page-summary").textContent?.startsWith("Rows 1–2") === true);
	element("next-page").click();
	await waitFor(() => element("page-summary").textContent?.startsWith("Rows 3–4") === true);
	element("next-page").click();
	await waitFor(() => element("page-summary").textContent?.startsWith("Rows 5–5") === true);
	assert.equal(element("page-limit-note").hidden, true);
	assert.equal(element<HTMLButtonElement>("next-page").disabled, true);
	assert.equal(element("preview-body").querySelector("td")?.textContent, values[4][0]);
	assert.equal(document.querySelector("#preview-body script"), null);
	assert.deepEqual(
		requests
			.filter(({ path }) => path.includes("/preview?"))
			.map(({ path }) => new URL(path, "http://localhost").searchParams.get("offset")),
		["0", "2", "2", "0", "2", "4"],
	);
});

test("retry waits for a fresh matching file, uploads its bytes, and leaves existing data visible on failure", async (t) => {
	const failed: ImportJob = {
		id: "failed-job",
		projectId: project.id,
		name: "original.csv",
		format: "csv",
		kind: "import",
		state: "failed",
		createdAt: timestamp,
		updatedAt: timestamp,
		bytesReceived: 5,
		bytesProcessed: 5,
		rowCount: 0,
		error: "Invalid CSV",
	};
	const retried: ImportJob = { ...failed, id: "retry-job", state: "uploading", retryOf: failed.id, error: undefined };
	const { element, browser, choose, requests } = await setup(t, {
		job: failed,
		respond(path, init) {
			if (path === `${importsUrl}/${failed.id}/retry` && init.method === "POST") return Response.json(retried);
			if (path === `${importsUrl}/${retried.id}/content` && init.method === "PUT")
				return Response.json({ ...retried, state: "failed", error: "Still invalid CSV" });
		},
	});
	for (const id of ["csv-file", "retry-file"])
		assert.ok(element<HTMLInputElement>(id).accept.split(",").includes("application/octet-stream"));
	assert.equal(element("retry-import").hidden, false);
	const originalRows = element("preview-body").textContent;
	element("retry-import").click();
	assert.equal(
		requests.some(({ init }) => init.method === "POST"),
		false,
	);
	element("retry-file").dispatchEvent(new browser.Event("cancel") as unknown as Event);
	assert.equal(
		requests.some(({ init }) => init.method === "POST"),
		false,
	);
	element("retry-import").click();
	choose("retry-file", new browser.File(["x\n1\n"], "different.csv", { type: "text/csv" }));
	assert.equal(
		requests.some(({ init }) => init.method === "POST"),
		false,
	);
	assert.match(element("notice-text").textContent ?? "", /same filename and format/);
	element("retry-import").click();
	const freshFile = new browser.File(["x\nnew bytes\n"], "original.csv", { type: "text/csv" });
	choose("retry-file", freshFile);
	await waitFor(() => element("operation-error").textContent === "Still invalid CSV");
	const upload = requests.find(({ init }) => init.method === "PUT");
	assert.ok(upload);
	assert.equal(upload.path, `${importsUrl}/${retried.id}/content`);
	assert.equal(upload.init.body, freshFile);
	assert.equal(new Headers(upload.init.headers).get("Content-Type"), "text/csv");
	assert.equal(element<HTMLInputElement>("retry-file").value, "");
	assert.equal(element("dataset").hidden, false);
	assert.equal(element("dataset-heading").textContent, dataset.name);
	assert.equal(element("preview-body").textContent, originalRows);
	assert.equal(element("retry-import").hidden, false);
});
