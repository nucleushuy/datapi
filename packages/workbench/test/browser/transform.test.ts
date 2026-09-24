import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window as TestWindow } from "happy-dom";
import type { Dataset, Project } from "../../src/contracts.ts";
import type {
	TransformHistory,
	TransformOperation,
	TransformPreview,
	TransformRecord,
	TransformSpec,
} from "../../src/transform-contracts.ts";

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
	id: "transform-project",
	ownerId: null,
	name: "Transforms",
	description: "",
	createdAt: timestamp,
	updatedAt: timestamp,
	settings: { previewRowLimit: 100 },
};
const otherProject: Project = { ...project, id: "other-project", name: "Other project" };
const dataset: Dataset = {
	id: "transform-data",
	projectId: project.id,
	name: "amounts.csv",
	originalFilename: "amounts.csv",
	format: "csv",
	createdAt: timestamp,
	updatedAt: timestamp,
	byteSize: 100,
	sha256: "a".repeat(64),
	rowCount: 1000,
	columnCount: 2,
	ingestionStatus: "ready",
	schemaVersion: 2,
	storageLocation: "source.csv",
	sourceVersionId: "source-one",
	currentVersionId: "input-one",
	versions: [],
	schema: [
		{ index: 0, name: "Amount", sourceType: "DOUBLE", basicType: "number" },
		{ index: 1, name: hostile, sourceType: "VARCHAR", basicType: "text" },
	],
	columns: [
		{ index: 0, name: "Amount", inferredType: "number", emptyCount: 1, numericCount: 999, min: 1, max: 1000 },
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
	currentVersionId: "other-version",
	name: "other.csv",
};
const base = `/api/projects/${project.id}/datasets/${dataset.id}`;
function makePreview(spec: TransformSpec, id = "preview-one"): TransformPreview {
	return {
		id,
		projectId: project.id,
		datasetId: dataset.id,
		createdAt: timestamp,
		expiresAt: new Date(Date.now() + 600_000).toISOString(),
		impact: {
			inputVersionId: spec.datasetVersionId,
			inputHash: dataset.sha256,
			spec,
			engineVersion: "duckdb-test",
			sql: "SELECT c0 AS renamed, c1 FROM input ORDER BY rowid",
			affectedRows: 1000,
			inputRows: 1000,
			rowCount: 999,
			schemaBefore: dataset.schema,
			schema: dataset.schema.map((column, index) => (index === 0 ? { ...column, name: "renamed" } : column)),
			columns: dataset.columns,
			nullChanges: [{ name: "Amount", before: 1, after: 0 }],
			before: [
				[null, hostile],
				["", "original"],
			],
			after: [["1", hostile]],
			warnings: ["DOUBLE arithmetic is approximate."],
		},
	};
}
async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Expected transform state did not settle");
		await pause(1);
	}
}
function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}
async function setup(
	t: TestContext,
	override?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined,
) {
	const browser = new TestWindow({
		url: "http://localhost:4310",
		width: 390,
		height: 844,
		settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
	});
	t.after(() => browser.happyDOM.close());
	browser.document.write(html);
	const requests: { path: string; init: RequestInit }[] = [];
	let active = structuredClone(dataset);
	const records: TransformRecord[] = [];
	let latest: TransformPreview | null = null;
	let counter = 0;
	let canRedo = false;
	const respond = async (path: string, init: RequestInit): Promise<Response> => {
		requests.push({ path, init });
		const intercepted = override?.(path, init);
		if (intercepted) return intercepted;
		if (path === "/api/bootstrap")
			return Response.json({
				token: "transform-token",
				projects: [project, otherProject],
				maxUploadBytes: 100_000_000,
				maxDecodedBytes: 256 * 1024 * 1024,
				maxPreviewRows: 500,
			});
		if (path === `/api/projects/${project.id}/datasets`) return Response.json([active]);
		if (path === `/api/projects/${otherProject.id}/datasets`) return Response.json([otherDataset]);
		if (path === base) return Response.json(active);
		if (path.endsWith(`/datasets/${otherDataset.id}`)) return Response.json(otherDataset);
		if (path.endsWith("/profile")) return Response.json({ profile: null });
		if (path.includes("/preview?"))
			return Response.json({
				offset: 0,
				limit: 100,
				total: active.rowCount,
				rows: [[active.currentVersionId, "active rows"]],
			});
		if (path.endsWith("/charts")) return Response.json([]);
		if (path.endsWith("/transforms/history"))
			return Response.json({
				currentVersionId: path.includes(otherProject.id) ? otherDataset.currentVersionId : active.currentVersionId,
				canUndo: active.currentVersionId !== dataset.currentVersionId,
				canRedo,
				records: path.includes(otherProject.id) ? [] : records,
			} satisfies TransformHistory);
		if (path.endsWith("/transforms/preview")) {
			const body = JSON.parse(String(init.body)) as { spec: TransformSpec };
			latest = makePreview(body.spec, `preview-${++counter}`);
			records.push({
				id: latest.id,
				projectId: project.id,
				datasetId: dataset.id,
				actor: "local-user",
				createdAt: timestamp,
				completedAt: null,
				inputVersionId: body.spec.datasetVersionId,
				outputVersionId: null,
				spec: body.spec,
				state: "previewed",
				result: latest.impact,
				error: null,
			});
			return Response.json(latest);
		}
		if (path.includes("/transforms/previews/") && init.method === "DELETE") {
			const record = records.find((item) => path.endsWith(item.id));
			if (record?.state === "previewed") record.state = "cancelled";
			return Response.json({ discarded: true });
		}
		if (path.endsWith("/transforms/apply")) {
			assert.ok(latest);
			const record = records.find((item) => item.id === latest?.id)!;
			record.state = "applied";
			record.completedAt = timestamp;
			record.outputVersionId = "output-one";
			active = {
				...active,
				currentVersionId: "output-one",
				rowCount: latest.impact.rowCount,
				schema: latest.impact.schema,
			};
			canRedo = false;
			return Response.json(active);
		}
		if (path.endsWith("/transforms/undo") || path.endsWith("/transforms/redo")) {
			canRedo = path.endsWith("/undo");
			active = {
				...active,
				currentVersionId: canRedo ? dataset.currentVersionId : "output-one",
				rowCount: canRedo ? 1000 : 999,
			};
			return Response.json(active);
		}
		throw new Error(`Unexpected transform request: ${init.method ?? "GET"} ${path}`);
	};
	browser.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const response = await respond(String(input), init);
		const text = await response.text();
		// Strict spec validation expects the browser's own plain-object prototype.
		response.json = async () => browser.eval(`JSON.parse(${JSON.stringify(text)})`);
		return response;
	}) as unknown as typeof browser.fetch;
	const document = browser.document as unknown as Document;
	function element<T extends HTMLElement = HTMLElement>(id: string): T {
		const value = document.getElementById(id);
		assert.ok(value, id);
		return value as T;
	}
	function change(id: string, value: string, event = "change"): void {
		element<HTMLInputElement>(id).value = value;
		element(id).dispatchEvent(new browser.Event(event, { bubbles: true }) as unknown as Event);
	}
	function approve(): void {
		element<HTMLInputElement>("transform-approval").checked = true;
		element("transform-approval").dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
	}
	async function preview(): Promise<void> {
		element("transform-preview").click();
		await waitFor(
			() => !element("transform-review").hidden && !element<HTMLButtonElement>("transform-preview").disabled,
		);
	}
	browser.eval(script);
	await waitFor(() => !element<HTMLButtonElement>("transform-preview").disabled);
	element("view-transform").click();
	await waitFor(
		() =>
			!(element("transform-history-status").textContent ?? "").includes("Loading") &&
			!(element("transform-history-status").textContent ?? "").includes("Open Transform"),
	);
	return { browser, document, element, change, approve, preview, requests, records };
}

test("exact impact, safe text, approval binding and persisted undo/redo refresh active rows", async (t) => {
	const ui = await setup(t);
	assert.equal(ui.element("transform-panel").hidden, false);
	assert.match(ui.element("transform-history-status").textContent ?? "", /No transformations/);
	assert.equal(
		ui.requests.some((request) => request.init.method === "POST"),
		false,
	);
	await ui.preview();
	const impact = ui.element("transform-review").textContent ?? "";
	for (const text of [
		"Affected rows (exact, full dataset)",
		"1000",
		"999",
		"Exact null changes",
		"Schema before",
		"Schema after",
		"Before sample",
		"After sample",
		"not an aligned row diff",
		"SELECT c0",
		"DOUBLE arithmetic",
		"NULL",
		"∅ (empty string)",
	])
		assert.ok(impact.includes(text), text);
	assert.equal(ui.document.querySelector("img"), null);
	assert.equal(ui.element<HTMLButtonElement>("transform-apply").disabled, true);
	ui.approve();
	assert.equal(ui.element<HTMLButtonElement>("transform-apply").disabled, false);
	ui.change("transform-name", "changed", "input");
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
	assert.equal(ui.element("transform-review").hidden, true);
	await waitFor(() =>
		ui.requests.some((request) => request.path.endsWith("/previews/preview-1") && request.init.method === "DELETE"),
	);
	await ui.preview();
	ui.approve();
	ui.element("transform-apply").click();
	await waitFor(
		() =>
			ui.element("preview-body").textContent?.includes("output-one") === true &&
			!ui.element<HTMLButtonElement>("transform-undo").disabled,
	);
	const apply = ui.requests.find((request) => request.path.endsWith("/transforms/apply"))!;
	assert.deepEqual(JSON.parse(String(apply.init.body)), { previewId: "preview-2", approved: true });
	assert.equal(new Headers(apply.init.headers).get("X-Workbench-Token"), "transform-token");
	assert.equal(ui.element("transform-panel").hidden, false);
	assert.match(ui.element("transform-history").textContent ?? "", /local-user/);
	assert.match(ui.element("transform-history").textContent ?? "", /output-one/);
	assert.ok(ui.requests.filter((request) => request.path.endsWith("/profile")).length >= 2);
	ui.element("transform-undo").click();
	await waitFor(
		() =>
			ui.element("preview-body").textContent?.includes("input-one") === true &&
			!ui.element<HTMLButtonElement>("transform-redo").disabled,
	);
	ui.element("transform-redo").click();
	await waitFor(
		() =>
			ui.element("preview-body").textContent?.includes("output-one") === true &&
			!ui.element<HTMLButtonElement>("transform-undo").disabled,
	);
	assert.deepEqual(
		ui.requests
			.filter((request) => /\/transforms\/(undo|redo)$/.test(request.path))
			.map((request) => JSON.parse(String(request.init.body))),
		[{ expectedVersionId: "output-one" }, { expectedVersionId: "input-one" }],
	);
});

test("every operation and variant is reachable with explicit literal parameters", async (t) => {
	const ui = await setup(t);
	const operations: TransformOperation[] = [
		{ kind: "rename", column: 0, name: "renamed" },
		...["text", "number", "integer", "boolean", "date", "timestamp"].flatMap((type) =>
			["error", "null"].map((invalid) => ({ kind: "cast", column: 0, type, invalid }) as TransformOperation),
		),
		{ kind: "drop", columns: [0] },
		{ kind: "deduplicate", columns: [0, 1] },
		...["eq", "ne", "lt", "lte", "gt", "gte", "contains", "is-null", "not-null"].map(
			(operator) =>
				({
					kind: "filter",
					column: 0,
					operator,
					comparison: "text",
					value: operator.includes("null") ? null : "1",
				}) as TransformOperation,
		),
		{ kind: "filter", column: 0, operator: "gt", comparison: "number", value: "2.5" },
		...["constant", "mean", "median", "drop"].flatMap((method) =>
			["null", "empty", "both"].map(
				(missing) =>
					({
						kind: "missing",
						columns: [0],
						method,
						missing,
						value: method === "constant" ? "0" : null,
					}) as TransformOperation,
			),
		),
		{ kind: "missing", columns: [0], method: "constant", missing: "empty", value: null },
		{
			kind: "map",
			column: 1,
			entries: [
				{ from: "old", to: "new" },
				{ from: "bad", to: null },
			],
			unmatched: "keep",
		},
		{ kind: "map", column: 1, entries: [{ from: "old", to: "new" }], unmatched: "null" },
		...["year", "month", "day", "weekday", "hour"].map(
			(component) => ({ kind: "datetime", column: 1, component, name: "date_part" }) as TransformOperation,
		),
		{ kind: "scale", column: 0, method: "standard", name: "scaled" },
		{ kind: "scale", column: 0, method: "minmax", name: "scaled" },
		{ kind: "encode", column: 1, method: "ordinal", categories: [], name: "encoded" },
		{ kind: "encode", column: 1, method: "one-hot", categories: ["low", "high"], name: "encoded" },
		{
			kind: "derive",
			name: "doubled",
			expression: {
				kind: "binary",
				operator: "multiply",
				left: { kind: "column", column: 0 },
				right: { kind: "literal", value: 2 },
			},
		},
	];
	for (const operation of operations) {
		ui.change("transform-kind", operation.kind);
		for (const [key, value] of Object.entries(operation)) {
			if (key === "kind") continue;
			if (key === "columns") {
				for (const option of ui.element<HTMLSelectElement>("transform-columns").options)
					option.selected = (value as number[]).includes(Number(option.value));
			} else
				ui.change(
					`transform-${key}`,
					value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value),
				);
		}
		if (operation.kind === "missing" && operation.method === "constant" && operation.value === null)
			ui.change("transform-value-type", "null");
		await ui.preview();
		const request = ui.requests.filter((request) => request.path.endsWith("/transforms/preview")).at(-1)!;
		assert.deepEqual(JSON.parse(String(request.init.body)).spec, {
			version: 1,
			datasetVersionId: "input-one",
			operation,
		});
		ui.element("transform-cancel").click();
	}
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/apply")),
		false,
	);
});

test("invalid expression or stale parameters cannot bypass exact approval", async (t) => {
	const ui = await setup(t);
	ui.change("transform-kind", "derive");
	ui.change("transform-expression", '{"kind":"call","function":"eval","args":[]}', "input");
	ui.element("transform-preview").click();
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/transforms/preview")),
		false,
	);
	assert.ok(ui.element("transform-error").textContent);
	ui.change("transform-kind", "rename");
	await ui.preview();
	ui.approve();
	// A programmatic edit without a DOM event must still fail the apply-time binding.
	ui.element<HTMLInputElement>("transform-name").value = "different";
	ui.element("transform-apply").click();
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/apply")),
		false,
	);
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
	assert.match(ui.element("transform-error").textContent ?? "", /Preview and approve again/i);
});

test("cancel aborts the worker request and late previews are discarded rather than approved", async (t) => {
	const pending = deferred();
	const ui = await setup(t, (path) => (path.endsWith("/transforms/preview") ? pending.promise : undefined));
	ui.element("transform-preview").click();
	await waitFor(() => ui.requests.some((request) => request.path.endsWith("/transforms/preview")));
	const request = ui.requests.find((request) => request.path.endsWith("/transforms/preview"))!;
	ui.element("transform-cancel").click();
	assert.equal(request.init.signal?.aborted, true);
	pending.resolve(Response.json(makePreview(JSON.parse(String(request.init.body)).spec, "late-preview")));
	await waitFor(() => ui.requests.some((request) => request.path.endsWith("/previews/late-preview")));
	assert.equal(ui.element("transform-review").hidden, true);
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/apply")),
		false,
	);
});

test("late apply responses cannot cross project selection", async (t) => {
	const pending = deferred();
	let delayApply = false;
	const ui = await setup(t, (path) =>
		delayApply && path.endsWith("/transforms/apply") ? pending.promise : undefined,
	);
	await ui.preview();
	ui.approve();
	delayApply = true;
	ui.element("transform-apply").click();
	await waitFor(() => ui.requests.some((request) => request.path.endsWith("/transforms/apply")));
	const request = ui.requests.find((request) => request.path.endsWith("/transforms/apply"))!;
	assert.equal(ui.element<HTMLButtonElement>("transform-cancel").disabled, true);
	ui.change("project-select", otherProject.id);
	await waitFor(() => ui.element("dataset-heading").textContent === otherDataset.name);
	assert.equal(request.init.signal?.aborted, true);
	pending.resolve(Response.json({ ...dataset, currentVersionId: "late-version" }));
	await pause(5);
	assert.match(ui.element("transform-context").textContent ?? "", /other-version/);
	assert.equal(ui.element("transform-review").hidden, true);
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
});

test("server failures preserve data and show retryable feedback without automatic mutation", async (t) => {
	const ui = await setup(t, (path) =>
		path.endsWith("/transforms/preview")
			? Response.json({ error: "Invalid cast at row 7" }, { status: 422 })
			: undefined,
	);
	ui.element("transform-preview").click();
	await waitFor(() => ui.element("transform-error").textContent?.includes("Invalid cast") === true);
	assert.match(ui.element("transform-status").textContent ?? "", /No version was applied/);
	assert.equal(ui.element<HTMLButtonElement>("transform-preview").disabled, false);
	assert.equal(ui.element<HTMLButtonElement>("transform-apply").disabled, true);
	assert.match(ui.element("preview-body").textContent ?? "", /input-one/);
	assert.equal(ui.requests.filter((request) => request.path.endsWith("/transforms/preview")).length, 1);
});

test("late preview from another project is discarded at its original scope", async (t) => {
	const pending = deferred();
	const ui = await setup(t, (path) => (path.endsWith("/transforms/preview") ? pending.promise : undefined));
	ui.element("transform-preview").click();
	await waitFor(() => ui.requests.some((request) => request.path.endsWith("/transforms/preview")));
	const request = ui.requests.find((request) => request.path.endsWith("/transforms/preview"))!;
	ui.change("project-select", otherProject.id);
	await waitFor(() => ui.element("dataset-heading").textContent === otherDataset.name);
	pending.resolve(Response.json(makePreview(JSON.parse(String(request.init.body)).spec, "old-project-preview")));
	await waitFor(() =>
		ui.requests.some((request) => request.path === `${base}/transforms/previews/old-project-preview`),
	);
	assert.equal(request.init.signal?.aborted, true);
	assert.equal(ui.element("transform-review").hidden, true);
	assert.match(ui.element("transform-context").textContent ?? "", /other-version/);
});

test("expired or mismatched previews never enable approval", async (t) => {
	let mismatch = false;
	const ui = await setup(t, (path, init) => {
		if (!path.endsWith("/transforms/preview")) return;
		const value = makePreview(JSON.parse(String(init.body)).spec);
		if (mismatch) value.impact.inputVersionId = "stale-version";
		else value.expiresAt = "2000-01-01T00:00:00.000Z";
		return Response.json(value);
	});
	ui.element("transform-preview").click();
	await waitFor(() => ui.element("transform-error").textContent?.includes("expired") === true);
	assert.equal(ui.element("transform-review").hidden, true);
	assert.equal(ui.element<HTMLButtonElement>("transform-apply").disabled, true);
	mismatch = true;
	ui.element("transform-preview").click();
	await waitFor(() => ui.element("transform-error").textContent?.includes("does not match") === true);
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/apply")),
		false,
	);
});

test("failed publication clears approval and exposes explicit dataset reload", async (t) => {
	const ui = await setup(t, (path) =>
		path.endsWith("/transforms/apply")
			? Response.json({ error: "Active version changed" }, { status: 409 })
			: undefined,
	);
	await ui.preview();
	ui.approve();
	ui.element("transform-apply").click();
	await waitFor(() => ui.element("transform-error").textContent?.includes("Active version changed") === true);
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
	assert.equal(ui.element("transform-review").hidden, true);
	assert.match(ui.element("preview-body").textContent ?? "", /input-one/);
	assert.equal(ui.requests.filter((request) => request.path.endsWith("/apply")).length, 1);
	const before = ui.requests.filter((request) => request.path === base).length;
	ui.element("transform-reload").click();
	await waitFor(() => ui.requests.filter((request) => request.path === base).length > before);
});

test("history is restored from server, failure records stay inspectable and undo requires active version", async (t) => {
	const spec: TransformSpec = {
		version: 1,
		datasetVersionId: "parent-version",
		operation: { kind: "rename", column: 0, name: "restored" },
	};
	const value: TransformHistory = {
		currentVersionId: dataset.currentVersionId,
		canUndo: true,
		canRedo: true,
		records: [
			{
				id: "failed-record",
				projectId: project.id,
				datasetId: dataset.id,
				actor: "local-user",
				createdAt: timestamp,
				completedAt: timestamp,
				inputVersionId: "parent-version",
				outputVersionId: null,
				spec,
				state: "failed",
				result: null,
				error: "Failed numeric conversion",
			},
		],
	};
	const ui = await setup(t, (path) => (path.endsWith("/transforms/history") ? Response.json(value) : undefined));
	await waitFor(() => !ui.element<HTMLButtonElement>("transform-undo").disabled);
	assert.equal(ui.element<HTMLButtonElement>("transform-redo").disabled, false);
	const text = ui.element("transform-history").textContent ?? "";
	for (const expected of [
		"local-user",
		timestamp,
		"parent-version",
		"Operation and parameters",
		"Failed numeric conversion",
		"No execution result recorded",
	])
		assert.ok(text.includes(expected), expected);
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/preview") || request.path.endsWith("/apply")),
		false,
	);
	ui.element("transform-undo").click();
	await waitFor(() => ui.requests.some((request) => request.path.endsWith("/transforms/undo")));
	assert.deepEqual(
		JSON.parse(String(ui.requests.find((request) => request.path.endsWith("/transforms/undo"))!.init.body)),
		{ expectedVersionId: dataset.currentVersionId },
	);
});

test("form submission and labeled controls expose preview without implicit approval", async (t) => {
	const ui = await setup(t);
	const name = ui.element<HTMLInputElement>("transform-name");
	name.focus();
	assert.equal(ui.document.activeElement, name);
	assert.equal(ui.document.querySelector('label[for="transform-name"]')?.textContent, "New column name");
	ui.element("transform-form").dispatchEvent(
		new ui.browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
	);
	await waitFor(() => !ui.element("transform-review").hidden);
	assert.equal(ui.element<HTMLInputElement>("transform-approval").checked, false);
	assert.ok(ui.document.querySelector('label[for="transform-approval"]'));
	assert.ok(ui.element("transform-review").querySelector('[role="region"][tabindex="0"]'));
	assert.ok(ui.element("transform-review").querySelector('pre[tabindex="0"]'));
	ui.element("transform-cancel").click();
	assert.equal(ui.document.activeElement?.id, "transform-preview");
	assert.equal(
		ui.requests.some((request) => request.path.endsWith("/apply")),
		false,
	);
});
