import {
	type Bootstrap,
	type Dataset,
	type ImportJob,
	MAX_UPLOAD_BYTES,
	type Preview,
	type Project,
} from "../contracts.ts";
import { initializeShell } from "./shell.ts";

const shell = initializeShell(document, window);

function element<T extends HTMLElement>(id: string): T {
	const result = document.getElementById(id);
	if (!result) throw new Error(`Missing interface element: ${id}`);
	return result as T;
}

function node<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
	className?: string,
): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (text !== undefined) result.textContent = text;
	if (className) result.className = className;
	return result;
}

const ui = {
	projectSelect: element<HTMLSelectElement>("project-select"),
	projectCount: element("project-count"),
	projectForm: element<HTMLFormElement>("project-form"),
	projectName: element<HTMLInputElement>("project-name"),
	projectError: element("project-error"),
	createProject: element<HTMLButtonElement>("create-project"),
	createDetails: element<HTMLDetailsElement>("create-details"),
	projectHeading: element("project-heading"),
	projectDescription: element("project-description"),
	datasetList: element("dataset-list"),
	datasetListStatus: element("dataset-list-status"),
	datasetCount: element("dataset-count"),
	retryDatasets: element<HTMLButtonElement>("retry-datasets"),
	importButton: element<HTMLButtonElement>("import-button"),
	file: element<HTMLInputElement>("csv-file"),
	importHelp: element("import-help"),
	notice: element("notice"),
	noticeText: element("notice-text"),
	dismissNotice: element<HTMLButtonElement>("dismiss-notice"),
	reload: element<HTMLButtonElement>("reload-app"),
	empty: element("empty-state"),
	emptyTitle: element("empty-title"),
	emptyDescription: element("empty-description"),
	emptyAction: element<HTMLButtonElement>("empty-action"),
	datasetLoading: element("dataset-loading"),
	datasetError: element("dataset-error"),
	datasetErrorText: element("dataset-error-text"),
	retryDataset: element<HTMLButtonElement>("retry-dataset"),
	dataset: element("dataset"),
	datasetHeading: element("dataset-heading"),
	datasetSummary: element("dataset-summary"),
	previewPanel: element("preview-panel"),
	profilePanel: element("profile-panel"),
	provenancePanel: element("provenance-panel"),
	previewView: element<HTMLButtonElement>("view-preview"),
	profileView: element<HTMLButtonElement>("view-profile"),
	provenanceView: element<HTMLButtonElement>("view-provenance"),
	previewStatus: element("preview-status"),
	retryPreview: element<HTMLButtonElement>("retry-preview"),
	previewScroll: element("preview-scroll"),
	previewHead: element("preview-head"),
	previewBody: element("preview-body"),
	pageSummary: element("page-summary"),
	previousPage: element<HTMLButtonElement>("previous-page"),
	nextPage: element<HTMLButtonElement>("next-page"),
	profileBody: element("profile-body"),
	provenance: element("provenance"),
	recompute: element<HTMLButtonElement>("recompute-button"),
	operation: element("operation"),
	operationTitle: element("operation-title"),
	operationContext: element("operation-context"),
	operationState: element("operation-state"),
	operationProgress: element<HTMLProgressElement>("operation-progress"),
	operationDetail: element("operation-detail"),
	operationError: element("operation-error"),
	cancelOperation: element<HTMLButtonElement>("cancel-operation"),
	retryOperation: element<HTMLButtonElement>("retry-operation"),
	openOperation: element<HTMLButtonElement>("open-operation"),
	dismissOperation: element<HTMLButtonElement>("dismiss-operation"),
	announcement: element("announcement"),
	persistenceNote: element("persistence-note"),
};

element("shell-statistics-content").append(ui.profilePanel);
ui.profilePanel.hidden = false;

interface Operation {
	id: string | null;
	job: ImportJob | null;
	kind: ImportJob["kind"];
	name: string;
	projectId: string;
	totalBytes: number;
	startSelection: number;
	cancelRequested: boolean;
	cancelling: boolean;
	finalized: boolean;
	statusError: string;
	paused: boolean;
	recovered: boolean;
	announcementKey: string;
	pollTimer: number | undefined;
	pollAbort: AbortController | null;
	uploadAbort: AbortController | null;
}

class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

type View = "preview" | "provenance";
let token = "";
let ready = false;
let maxUploadBytes = MAX_UPLOAD_BYTES;
let projects: Project[] = [];
let datasets: Dataset[] = [];
let projectId: string | null = null;
let datasetId: string | null = null;
let dataset: Dataset | null = null;
let currentView: View = "preview";
let creatingProject = false;
let listingDatasets = false;
let selectionVersion = 0;
let listVersion = 0;
let datasetVersion = 0;
let previewVersion = 0;
let listAbort: AbortController | null = null;
let datasetAbort: AbortController | null = null;
let previewAbort: AbortController | null = null;
let previewOffset = 0;
let nextOffset = 0;
let pageOffsets: number[] = [0];
let pageIndex = 0;
let operation: Operation | null = null;
const countFormatter = new Intl.NumberFormat();
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const storagePrefix = "datapi.workbench.";

function count(value: number): string {
	return countFormatter.format(value);
}
function bytes(value: number): string {
	if (value < 1_000) return `${count(value)} B`;
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} kB`;
	return `${(value / 1_000_000).toFixed(1)} MB`;
}
function date(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}
function stored(key: string, value?: string | null, session = false): string | null {
	try {
		const storage = session ? window.sessionStorage : window.localStorage;
		const fullKey = storagePrefix + key;
		if (value === undefined) return storage.getItem(fullKey);
		if (value === null) storage.removeItem(fullKey);
		else storage.setItem(fullKey, value);
	} catch {
		ui.persistenceNote.textContent =
			"Browser storage unavailable: selections and job recovery will not survive reload. Datasets remain on disk.";
	}
	return null;
}
function announce(text: string): void {
	ui.announcement.textContent = text;
}
function showNotice(text: string, reload = false): void {
	ui.noticeText.textContent = text;
	ui.reload.hidden = !reload;
	ui.notice.hidden = false;
}
function message(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 401 || error.status === 403)
			showNotice("This browser session is no longer authorized. Reload to reconnect to the local server.", true);
		return error.message;
	}
	return "Could not reach the local server. Check that the workbench is running, then try again.";
}
function isAborted(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	const headers = new Headers(options.headers);
	headers.set("X-Workbench-Token", token);
	const response = await fetch(path, { ...options, headers, credentials: "same-origin", redirect: "error" });
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		if (isAborted(error)) throw error;
		throw new ApiError("The local server returned an unreadable response. Reload to reconnect.", response.status);
	}
	if (!response.ok) {
		const detail =
			typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
				? body.error
				: `The request could not be completed (${response.status}).`;
		throw new ApiError(detail, response.status);
	}
	return body as T;
}
function projectPath(id: string): string {
	return `/api/projects/${encodeURIComponent(id)}/datasets`;
}
function datasetPath(owner: string, id: string): string {
	return `${projectPath(owner)}/${encodeURIComponent(id)}`;
}
function jobPath(id: string): string {
	return `/api/imports/${encodeURIComponent(id)}`;
}
function operationActive(): boolean {
	return operation !== null && !operation.finalized;
}
function updateControls(): void {
	ui.projectSelect.disabled = !ready || projects.length === 0;
	ui.projectName.disabled = !ready || creatingProject;
	ui.createProject.disabled = !ready || creatingProject;
	ui.createProject.textContent = creatingProject ? "Creating…" : "Create project";
	ui.importButton.disabled = !ready || projectId === null || operationActive();
	ui.emptyAction.disabled = !ready || (projectId !== null && (operationActive() || listingDatasets));
	ui.recompute.disabled = !ready || dataset === null || operationActive();
}

function renderProjects(): void {
	const options = document.createDocumentFragment();
	if (projects.length === 0) options.append(node("option", "No projects yet"));
	for (const project of projects) {
		const option = node("option", project.name);
		option.value = project.id;
		options.append(option);
	}
	ui.projectSelect.replaceChildren(options);
	if (projectId) ui.projectSelect.value = projectId;
	ui.projectCount.textContent = count(projects.length);
	updateControls();
}

function updateDatasetSelection(): void {
	ui.datasetList.querySelectorAll<HTMLButtonElement>("button[data-dataset-id]").forEach((button) => {
		if (button.dataset.datasetId === datasetId) button.setAttribute("aria-current", "true");
		else button.removeAttribute("aria-current");
	});
}

function renderDatasetList(): void {
	const fragment = document.createDocumentFragment();
	for (const item of datasets) {
		const li = node("li");
		const button = node("button", undefined, "dataset-link");
		button.type = "button";
		button.dataset.datasetId = item.id;
		button.title = item.name;
		button.append(
			node("span", item.name, "dataset-link-name"),
			node("span", `${count(item.rowCount)} rows · ${count(item.columnCount)} cols`, "dataset-link-meta"),
		);
		button.addEventListener("click", () => {
			void selectDataset(item.id);
		});
		li.append(button);
		fragment.append(li);
	}
	ui.datasetList.replaceChildren(fragment);
	ui.datasetCount.textContent = count(datasets.length);
	ui.datasetListStatus.hidden = datasets.length > 0;
	ui.datasetListStatus.textContent = "No datasets yet. Import a CSV to get started.";
	updateDatasetSelection();
}

function renderEmpty(): void {
	ui.empty.hidden = false;
	if (projectId === null) {
		ui.emptyTitle.textContent = "A place to understand your data.";
		ui.emptyDescription.textContent =
			"Create a project, import a CSV, and inspect the original rows alongside reproducible column statistics.";
		ui.emptyAction.textContent = "Create your first project";
	} else {
		ui.emptyTitle.textContent = "Start with the original data.";
		ui.emptyDescription.textContent =
			"Import a CSV into this project. Explore its rows, inspect every column, and keep a verifiable record of the source.";
		ui.emptyAction.textContent = "Choose a CSV file";
	}
	updateControls();
}

function resetDataset(): void {
	datasetVersion++;
	previewVersion++;
	datasetAbort?.abort();
	previewAbort?.abort();
	dataset = null;
	shell.setDatasetAvailable(false);
	datasetId = null;
	previewOffset = 0;
	nextOffset = 0;
	pageOffsets = [0];
	pageIndex = 0;
	ui.dataset.hidden = true;
	ui.datasetError.hidden = true;
	ui.datasetLoading.hidden = true;
	ui.previewHead.replaceChildren();
	ui.previewBody.replaceChildren();
	ui.profileBody.replaceChildren();
	ui.provenance.replaceChildren();
	updateControls();
}

async function selectProject(id: string | null, preferredDataset?: string): Promise<void> {
	selectionVersion++;
	listVersion++;
	listAbort?.abort();
	projectId = id;
	datasets = [];
	listingDatasets = false;
	resetDataset();
	ui.datasetList.replaceChildren();
	ui.retryDatasets.hidden = true;
	ui.datasetCount.textContent = "—";
	stored("project", id);
	if (id === null) {
		ui.projectHeading.textContent = "Your local workspace";
		ui.projectDescription.textContent = "A clear view of your data, from source to statistics.";
		ui.datasetListStatus.hidden = false;
		ui.datasetListStatus.textContent = "Create a project to organize your datasets.";
		renderEmpty();
		return;
	}
	ui.projectSelect.value = id;
	ui.projectHeading.textContent = projects.find((project) => project.id === id)?.name ?? "Project";
	ui.projectDescription.textContent = "Explore original data. Inspect reproducible profiles.";
	ui.empty.hidden = true;
	await loadDatasets(id, preferredDataset);
}

async function loadDatasets(owner: string, preferredDataset?: string): Promise<void> {
	const request = ++listVersion;
	listAbort?.abort();
	const controller = new AbortController();
	listAbort = controller;
	listingDatasets = true;
	ui.datasetListStatus.hidden = false;
	ui.datasetListStatus.textContent = "Loading datasets…";
	ui.retryDatasets.hidden = true;
	updateControls();
	try {
		const loaded = await api<Dataset[]>(projectPath(owner), { signal: controller.signal });
		if (request !== listVersion || projectId !== owner) return;
		datasets = loaded;
		listingDatasets = false;
		renderDatasetList();
		const preferred = preferredDataset ?? stored(`dataset.${owner}`);
		const chosen =
			datasets.find((item) => item.id === datasetId) ??
			datasets.find((item) => item.id === preferred) ??
			datasets[0];
		if (chosen) {
			if (chosen.id !== datasetId || dataset === null) await selectDataset(chosen.id);
		} else {
			resetDataset();
			stored(`dataset.${owner}`, null);
			renderEmpty();
		}
	} catch (error) {
		if (request !== listVersion || projectId !== owner || isAborted(error)) return;
		ui.datasetListStatus.hidden = false;
		ui.datasetListStatus.textContent = message(error);
		ui.retryDatasets.hidden = false;
		announce("Could not load datasets. Use Retry loading datasets in the project sidebar.");
	} finally {
		if (request === listVersion) {
			listingDatasets = false;
			updateControls();
		}
	}
}

async function selectDataset(id: string, preserveView = false): Promise<void> {
	if (!projectId) return;
	const owner = projectId;
	const view = preserveView ? currentView : "preview";
	selectionVersion++;
	resetDataset();
	datasetId = id;
	const request = ++datasetVersion;
	const controller = new AbortController();
	datasetAbort = controller;
	stored(`dataset.${owner}`, id);
	updateDatasetSelection();
	ui.empty.hidden = true;
	ui.datasetLoading.hidden = false;
	try {
		const loaded = await api<Dataset>(datasetPath(owner, id), { signal: controller.signal });
		if (request !== datasetVersion || projectId !== owner || datasetId !== id) return;
		dataset = loaded;
		ui.datasetLoading.hidden = true;
		renderDataset(loaded);
		showView(view);
		announce(`${loaded.name}, ${count(loaded.rowCount)} rows and ${count(loaded.columnCount)} columns.`);
		await loadPreview(0);
	} catch (error) {
		if (request !== datasetVersion || isAborted(error)) return;
		ui.datasetLoading.hidden = true;
		ui.datasetError.hidden = false;
		ui.datasetErrorText.textContent = message(error);
	} finally {
		if (request === datasetVersion) updateControls();
	}
}

function renderDataset(value: Dataset): void {
	ui.dataset.hidden = false;
	shell.setDatasetAvailable(true);
	ui.datasetHeading.textContent = value.name;
	ui.datasetSummary.textContent = `${count(value.rowCount)} rows · ${count(value.columnCount)} columns · ${bytes(value.byteSize)}`;
	const header = node("tr");
	const rowNumber = node("th", "Row", "row-number");
	rowNumber.scope = "col";
	header.append(rowNumber);
	const profiles = document.createDocumentFragment();
	for (const column of value.columns) {
		const heading = node("th", column.name);
		heading.scope = "col";
		heading.title = column.name;
		header.append(heading);
		const row = node("tr");
		const name = node("th");
		name.scope = "row";
		name.title = column.name;
		name.append(node("span", String(column.index + 1).padStart(2, "0"), "column-index"), node("span", column.name));
		const type = node("td");
		type.append(node("span", column.inferredType, `type-label type-${column.inferredType}`));
		row.append(
			name,
			type,
			node("td", count(column.emptyCount), "numeric"),
			node("td", count(column.numericCount), "numeric"),
			node("td", column.min === null ? "—" : String(column.min), "numeric"),
			node("td", column.max === null ? "—" : String(column.max), "numeric"),
		);
		profiles.append(row);
	}
	ui.previewHead.replaceChildren(header);
	ui.profileBody.replaceChildren(profiles);
	const facts: [string, string][] = [
		["Source file", value.name],
		["Dataset ID", value.id],
		["Imported", date(value.createdAt)],
		["Source size", `${count(value.byteSize)} bytes`],
		["SHA-256", value.sha256],
		[
			"Parsing",
			`${value.parsing.encoding.toUpperCase()} · delimiter ${JSON.stringify(value.parsing.delimiter)} · first row is header`,
		],
		["Empty values", "Empty strings only; whitespace and original values are preserved"],
		["Profile method", `Deterministic full-file scan · version ${value.profileVersion}`],
		[
			"Type inference",
			"All nonempty finite decimal/exponent values: number. All true/false: boolean. No nonempty values: empty. Otherwise: text.",
		],
		["Last profiled", date(value.profiledAt)],
	];
	const provenance = document.createDocumentFragment();
	for (const [label, detail] of facts) provenance.append(node("dt", label), node("dd", detail));
	ui.provenance.replaceChildren(provenance);
	updateControls();
}

function showView(view: View): void {
	currentView = view;
	ui.previewPanel.hidden = view === "provenance";
	ui.provenancePanel.hidden = view !== "provenance";
	ui.previewView.setAttribute("aria-pressed", String(view !== "provenance"));
	ui.provenanceView.setAttribute("aria-pressed", String(view === "provenance"));
}

async function loadPreview(offset: number): Promise<void> {
	if (!projectId || !datasetId || !dataset) return;
	const owner = projectId;
	const id = datasetId;
	const request = ++previewVersion;
	previewAbort?.abort();
	const controller = new AbortController();
	previewAbort = controller;
	previewOffset = offset;
	ui.previewPanel.setAttribute("aria-busy", "true");
	ui.previewStatus.hidden = false;
	ui.previewStatus.textContent = "Loading original rows…";
	ui.previewScroll.hidden = true;
	ui.retryPreview.hidden = true;
	ui.previousPage.disabled = true;
	ui.nextPage.disabled = true;
	ui.pageSummary.textContent = "Loading page…";
	try {
		const preview = await api<Preview>(`${datasetPath(owner, id)}/preview?offset=${offset}`, {
			signal: controller.signal,
		});
		if (request !== previewVersion || projectId !== owner || datasetId !== id) return;
		const rows = document.createDocumentFragment();
		for (const [index, values] of preview.rows.entries()) {
			const row = node("tr");
			const number = node("th", count(preview.offset + index + 1), "row-number");
			number.scope = "row";
			row.append(number);
			for (const value of values) {
				const cell = node("td");
				if (value === "") {
					cell.textContent = "∅";
					cell.className = "cell-empty";
					cell.setAttribute("aria-label", "Empty string");
				} else {
					const content = node("div", value, "cell-value");
					if (value.length > 32 || value.includes("\n") || value.includes("\r")) {
						content.tabIndex = 0;
						content.setAttribute("role", "region");
						content.setAttribute("aria-label", "Scrollable cell value");
					}
					cell.append(content);
				}
				row.append(cell);
			}
			rows.append(row);
		}
		ui.previewBody.replaceChildren(rows);
		ui.previewScroll.hidden = preview.rows.length === 0;
		ui.previewStatus.hidden = preview.rows.length > 0;
		ui.previewStatus.textContent =
			"This file contains a header but no data rows. Column names are available in Column profile.";
		previewOffset = preview.offset;
		nextOffset = preview.offset + preview.rows.length;
		ui.pageSummary.textContent =
			preview.total === 0
				? "0 data rows"
				: `Rows ${count(preview.offset + 1)}–${count(nextOffset)} of ${count(preview.total)}`;
		ui.previousPage.disabled = pageIndex === 0;
		ui.nextPage.disabled = nextOffset >= preview.total || preview.rows.length === 0;
		ui.previewScroll.scrollTop = 0;
		announce(ui.pageSummary.textContent);
	} catch (error) {
		if (request !== previewVersion || isAborted(error)) return;
		ui.previewStatus.textContent = message(error);
		ui.retryPreview.hidden = false;
		ui.pageSummary.textContent = "Preview unavailable";
		announce("Could not load the preview. Use Retry preview.");
	} finally {
		if (request === previewVersion) ui.previewPanel.setAttribute("aria-busy", "false");
	}
}

function newOperation(kind: ImportJob["kind"], name: string, owner: string, totalBytes: number): Operation {
	const value: Operation = {
		id: null,
		job: null,
		kind,
		name,
		projectId: owner,
		totalBytes,
		startSelection: selectionVersion,
		cancelRequested: false,
		cancelling: false,
		finalized: false,
		statusError: "",
		paused: false,
		recovered: false,
		announcementKey: "",
		pollTimer: undefined,
		pollAbort: null,
		uploadAbort: null,
	};
	operation = value;
	renderOperation(value);
	return value;
}

function rememberOperation(value: Operation): void {
	if (value.id && !value.finalized)
		stored("operation", JSON.stringify({ id: value.id, totalBytes: value.totalBytes }), true);
}

function renderOperation(value: Operation): void {
	if (operation !== value) return;
	const job = value.job;
	const state =
		value.finalized && value.paused ? "unavailable" : value.finalized && !job ? "failed" : (job?.state ?? "starting");
	ui.operation.hidden = false;
	ui.operation.dataset.state = state;
	ui.operationTitle.textContent = value.name;
	const ownerName = projects.find((project) => project.id === value.projectId)?.name;
	ui.operationContext.textContent = `${value.kind === "import" ? "CSV import" : "Profile recomputation"}${ownerName ? ` / ${ownerName}` : ""}`;
	const labels: Record<string, string> = {
		starting: "Preparing",
		uploading: "Uploading",
		processing: "Processing",
		completed: "Complete",
		cancelled: "Cancelled",
		failed: "Failed",
	};
	ui.operationState.textContent =
		value.cancelRequested && !value.finalized
			? "Cancelling…"
			: value.paused
				? "Status unavailable"
				: (labels[state] ?? state);
	ui.operationError.textContent = value.statusError || job?.error || "";
	ui.operationError.hidden = ui.operationError.textContent.length === 0;
	ui.cancelOperation.hidden = value.finalized;
	ui.cancelOperation.disabled = value.cancelling || value.cancelRequested;
	ui.cancelOperation.textContent = value.cancelRequested ? "Cancelling…" : "Cancel";
	ui.retryOperation.hidden = !value.paused || value.finalized;
	ui.dismissOperation.hidden = !value.finalized;
	ui.openOperation.hidden = job?.state !== "completed" || !job?.datasetId;
	ui.operationProgress.hidden = value.finalized && state !== "completed";
	if (state === "completed") {
		ui.operationProgress.max = 1;
		ui.operationProgress.value = 1;
		ui.operationDetail.textContent =
			value.kind === "import"
				? `${count(job?.rowCount ?? 0)} rows imported. Source and profile saved locally.`
				: "Profile recomputed from the preserved source.";
	} else if (state === "cancelled") {
		ui.operationDetail.textContent =
			value.kind === "import"
				? "Import cancelled. No dataset was added."
				: "Recomputation cancelled. The previous profile is unchanged.";
	} else if (state === "unavailable") {
		ui.operationDetail.textContent = "The server no longer has a status record for this operation.";
	} else if (state === "failed") {
		ui.operationDetail.textContent =
			value.kind === "import"
				? "Import failed. Check the file and try again."
				: "Recomputation failed. The previous profile is unchanged.";
	} else if (job) {
		const processed = state === "uploading" ? job.bytesReceived : job.bytesProcessed;
		if (value.totalBytes > 0) {
			ui.operationProgress.max = value.totalBytes;
			ui.operationProgress.value = Math.min(processed, value.totalBytes);
		} else ui.operationProgress.removeAttribute("value");
		ui.operationDetail.textContent =
			state === "uploading"
				? `${bytes(job.bytesReceived)}${value.totalBytes ? ` / ${bytes(value.totalBytes)}` : ""} received by the local server`
				: `${bytes(job.bytesProcessed)}${value.totalBytes ? ` / ${bytes(value.totalBytes)}` : ""} scanned · ${count(job.rowCount)} rows processed`;
		const bucket = value.totalBytes > 0 ? Math.floor(Math.min(1, processed / value.totalBytes) * 10) : 0;
		const key = `${state}:${bucket}`;
		if (key !== value.announcementKey && !value.cancelRequested) {
			value.announcementKey = key;
			announce(`${labels[state] ?? state}: ${value.name}. ${ui.operationDetail.textContent}.`);
		}
	} else {
		ui.operationProgress.removeAttribute("value");
		ui.operationDetail.textContent = value.recovered
			? "Recovering the previous operation from the local server…"
			: "Preparing the local operation…";
	}
	updateControls();
}

function stopPolling(value: Operation): void {
	if (value.pollTimer !== undefined) window.clearTimeout(value.pollTimer);
	value.pollTimer = undefined;
	value.pollAbort?.abort();
	value.pollAbort = null;
}

function schedulePoll(value: Operation): void {
	if (operation !== value || value.finalized || value.paused || value.cancelling || value.pollTimer !== undefined)
		return;
	value.pollTimer = window.setTimeout(() => {
		value.pollTimer = undefined;
		void pollOperation(value);
	}, 400);
}

async function pollOperation(value: Operation): Promise<void> {
	if (operation !== value || value.finalized || !value.id || value.cancelling) return;
	value.pollAbort?.abort();
	const controller = new AbortController();
	value.pollAbort = controller;
	try {
		const job = await api<ImportJob>(jobPath(value.id), { signal: controller.signal });
		if (operation !== value || controller.signal.aborted || value.finalized) return;
		value.paused = false;
		value.statusError = "";
		if (value.recovered && job.state === "uploading")
			value.statusError =
				"An interrupted upload cannot resume after reload. Cancel this operation, then choose the file again.";
		applyJob(value, job);
		if (value.cancelRequested && !value.cancelling && !value.finalized) await cancelOperation(value);
	} catch (error) {
		if (operation !== value || value.finalized || isAborted(error)) return;
		value.paused = true;
		value.statusError = `${message(error)} Progress monitoring is paused; use Check status or Cancel.`;
		if (error instanceof ApiError && error.status === 404) {
			value.finalized = true;
			value.statusError =
				"This operation is no longer available, possibly because the server restarted. Reload the dataset list to check whether it finished.";
			stored("operation", null, true);
			value.uploadAbort?.abort();
			ui.retryDatasets.hidden = false;
		}
		renderOperation(value);
	} finally {
		if (value.pollAbort === controller) value.pollAbort = null;
		schedulePoll(value);
	}
}

function applyJob(value: Operation, job: ImportJob): void {
	if (operation !== value || value.finalized) return;
	if (value.job?.state === "processing" && job.state === "uploading") return;
	value.id = job.id;
	value.name = job.name;
	value.projectId = job.projectId;
	value.kind = job.kind;
	value.job = job;
	const terminal = job.state === "completed" || job.state === "cancelled" || job.state === "failed";
	const moveFocus = document.activeElement === ui.cancelOperation || document.activeElement === ui.retryOperation;
	if (terminal) {
		value.finalized = true;
		stopPolling(value);
		stored("operation", null, true);
	}
	renderOperation(value);
	if (!terminal) return;
	announce(
		`${job.kind === "import" ? "Import" : "Profile recomputation"} ${job.state}: ${job.name}.${job.error ? ` ${job.error}` : ""}`,
	);
	if (moveFocus) ui.dismissOperation.focus();
	if (job.state === "completed" && job.datasetId && projectId === job.projectId) {
		if (job.kind === "reprofile" && datasetId === job.datasetId) void selectDataset(job.datasetId, true);
		else if (selectionVersion === value.startSelection) void selectProject(job.projectId, job.datasetId);
		else void loadDatasets(job.projectId);
	}
}

async function cancelOperation(value: Operation): Promise<void> {
	if (operation !== value || value.finalized || value.cancelling) return;
	value.cancelRequested = true;
	value.uploadAbort?.abort();
	if (!value.id) {
		renderOperation(value);
		return;
	}
	value.cancelling = true;
	stopPolling(value);
	renderOperation(value);
	try {
		const job = await api<ImportJob>(jobPath(value.id), { method: "DELETE" });
		if (operation !== value || value.finalized) return;
		value.paused = false;
		value.statusError = "";
		applyJob(value, job);
	} catch (error) {
		if (operation !== value || value.finalized) return;
		value.cancelRequested = false;
		value.paused = true;
		value.statusError = `${message(error)} Cancellation is not confirmed. Check status or try Cancel again.`;
	} finally {
		value.cancelling = false;
		renderOperation(value);
		schedulePoll(value);
	}
}

async function importFile(file: File): Promise<void> {
	if (!ready || !projectId || operationActive()) return;
	if (file.size === 0) {
		showNotice("This file is empty. Choose a CSV with a nonempty header row.");
		return;
	}
	if (file.size > maxUploadBytes) {
		showNotice(
			`This file is ${bytes(file.size)}. Choose a CSV no larger than ${bytes(maxUploadBytes)} (${count(maxUploadBytes)} bytes).`,
		);
		return;
	}
	const owner = projectId;
	const value = newOperation("import", file.name, owner, file.size);
	try {
		const job = await api<ImportJob>(`/api/projects/${encodeURIComponent(owner)}/imports`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: file.name }),
		});
		applyJob(value, job);
		rememberOperation(value);
		if (value.cancelRequested) {
			await cancelOperation(value);
			return;
		}
		const controller = new AbortController();
		value.uploadAbort = controller;
		schedulePoll(value);
		const uploaded = await api<ImportJob>(`${jobPath(job.id)}/content`, {
			method: "PUT",
			headers: { "Content-Type": "text/csv" },
			body: file,
			signal: controller.signal,
		});
		applyJob(value, uploaded);
	} catch (error) {
		if (operation !== value || value.finalized || value.cancelRequested) return;
		const detail = message(error);
		if (!value.id) {
			value.finalized = true;
			value.statusError = detail;
		} else {
			await cancelOperation(value);
			value.statusError = value.statusError ? `${detail} ${value.statusError}` : detail;
		}
		renderOperation(value);
	} finally {
		value.uploadAbort = null;
	}
}

async function recompute(): Promise<void> {
	if (!ready || !dataset || !projectId || operationActive()) return;
	const source = dataset;
	const owner = projectId;
	const value = newOperation("reprofile", source.name, owner, source.byteSize);
	try {
		const job = await api<ImportJob>(`${datasetPath(owner, source.id)}/reprofile`, { method: "POST" });
		applyJob(value, job);
		rememberOperation(value);
		if (value.cancelRequested && !value.finalized) await cancelOperation(value);
		else schedulePoll(value);
	} catch (error) {
		if (operation !== value || value.finalized) return;
		value.finalized = true;
		value.statusError = message(error);
		renderOperation(value);
	}
}

async function restoreOperation(): Promise<void> {
	const saved = stored("operation", undefined, true);
	if (!saved) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(saved);
	} catch {
		stored("operation", null, true);
		showNotice("The saved operation reference could not be read. Your datasets remain on disk.");
		return;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("id" in parsed) ||
		typeof parsed.id !== "string" ||
		!("totalBytes" in parsed) ||
		typeof parsed.totalBytes !== "number" ||
		!Number.isFinite(parsed.totalBytes) ||
		parsed.totalBytes < 0
	) {
		stored("operation", null, true);
		showNotice("The saved operation reference is invalid. Your datasets remain on disk.");
		return;
	}
	const value = newOperation("import", "Previous operation", "", parsed.totalBytes);
	value.id = parsed.id;
	value.startSelection = -1;
	value.recovered = true;
	renderOperation(value);
	await pollOperation(value);
}

async function createProject(): Promise<void> {
	if (!ready || creatingProject) return;
	const name = ui.projectName.value.trim();
	if (!name) {
		ui.projectName.setCustomValidity("Enter a project name, not only spaces.");
		ui.projectName.reportValidity();
		return;
	}
	creatingProject = true;
	ui.projectError.hidden = true;
	updateControls();
	try {
		const project = await api<Project>("/api/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		projects.push(project);
		renderProjects();
		ui.projectName.value = "";
		ui.createDetails.open = false;
		await selectProject(project.id);
		announce(`Project ${project.name} created. Import a CSV to begin.`);
		ui.importButton.focus();
	} catch (error) {
		ui.projectError.textContent = message(error);
		ui.projectError.hidden = false;
	} finally {
		creatingProject = false;
		updateControls();
	}
}

async function bootstrap(): Promise<void> {
	try {
		const response = await fetch("/api/bootstrap", { credentials: "same-origin", redirect: "error" });
		if (!response.ok) throw new ApiError(`Could not open the local workbench (${response.status}).`, response.status);
		const initial: Bootstrap = await response.json();
		token = initial.token;
		projects = initial.projects;
		maxUploadBytes = initial.maxUploadBytes;
		ui.importHelp.textContent = `UTF-8 · Comma-separated · Unique header required · Up to ${bytes(maxUploadBytes)}`;
		renderProjects();
		const savedProject = stored("project");
		const selected = projects.find((project) => project.id === savedProject) ?? projects[0];
		await selectProject(selected?.id ?? null);
		await restoreOperation();
		ready = true;
		updateControls();
	} catch (error) {
		ready = false;
		ui.projectHeading.textContent = "Workbench unavailable";
		ui.projectDescription.textContent = "Reconnect to the local server to open your projects.";
		ui.empty.hidden = true;
		ui.projectSelect.replaceChildren(node("option", "Unable to load projects"));
		showNotice(message(error), true);
		updateControls();
	} finally {
		shell.setLoading(false);
	}
}

ui.projectForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void createProject();
});
ui.projectName.addEventListener("input", () => {
	ui.projectName.setCustomValidity("");
});
ui.projectSelect.addEventListener("change", () => {
	void selectProject(ui.projectSelect.value);
});
ui.importButton.addEventListener("click", () => {
	ui.file.click();
});
ui.file.addEventListener("change", () => {
	const file = ui.file.files?.[0];
	ui.file.value = "";
	if (file) void importFile(file);
});
ui.emptyAction.addEventListener("click", () => {
	if (projectId) ui.file.click();
	else {
		ui.createDetails.open = true;
		ui.projectName.focus();
	}
});
ui.dismissNotice.addEventListener("click", () => {
	ui.notice.hidden = true;
	ui.projectSelect.focus();
});
ui.reload.addEventListener("click", () => {
	window.location.reload();
});
ui.retryDatasets.addEventListener("click", () => {
	if (projectId) void loadDatasets(projectId);
});
ui.retryDataset.addEventListener("click", () => {
	if (datasetId) void selectDataset(datasetId);
});
ui.previewView.addEventListener("click", () => {
	showView("preview");
	shell.selectCenter("data");
});
ui.profileView.addEventListener("click", () => {
	shell.selectCenter("statistics", true);
});
ui.provenanceView.addEventListener("click", () => {
	showView("provenance");
	shell.selectCenter("data");
});
ui.previousPage.addEventListener("click", () => {
	if (pageIndex === 0) return;
	pageIndex--;
	void loadPreview(pageOffsets[pageIndex] ?? 0);
});
ui.nextPage.addEventListener("click", () => {
	pageOffsets = pageOffsets.slice(0, pageIndex + 1);
	pageOffsets.push(nextOffset);
	pageIndex++;
	void loadPreview(nextOffset);
});
ui.retryPreview.addEventListener("click", () => {
	void loadPreview(previewOffset);
});
ui.recompute.addEventListener("click", () => {
	void recompute();
});
ui.cancelOperation.addEventListener("click", () => {
	if (operation) void cancelOperation(operation);
});
ui.retryOperation.addEventListener("click", () => {
	if (!operation || operation.finalized) return;
	stopPolling(operation);
	operation.paused = false;
	operation.statusError = "";
	renderOperation(operation);
	void pollOperation(operation);
});
ui.openOperation.addEventListener("click", async () => {
	const job = operation?.job;
	if (job?.datasetId) {
		await selectProject(job.projectId, job.datasetId);
		shell.selectCenter("data");
		if (projectId === job.projectId && datasetId === job.datasetId) ui.previewView.focus();
	}
});
ui.dismissOperation.addEventListener("click", () => {
	if (operationActive()) return;
	operation = null;
	ui.operation.hidden = true;
	updateControls();
	ui.importButton.focus();
});
window.addEventListener("beforeunload", (event) => {
	if (operationActive() && (operation?.job?.state === "uploading" || operation?.job === null)) event.preventDefault();
});

void bootstrap();
