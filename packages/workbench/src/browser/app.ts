import {
	type Bootstrap,
	type Dataset,
	type DatasetFormat,
	type ImportJob,
	MAX_PREVIEW_ROWS,
	MAX_UPLOAD_BYTES,
	PAGE_SIZE,
	type Preview,
	type Project,
} from "../contracts.ts";
import {
	type ColumnProfile,
	type DatasetProfile,
	PROFILER_VERSION,
	type ProfileResponse,
} from "../profile-contracts.ts";
import { type AssistantUiContext, initializeAssistant } from "./assistant.ts";
import { initializeChartStudio } from "./chart-studio.ts";
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
	projectDescriptionInput: element<HTMLTextAreaElement>("project-description-input"),
	projectPreviewLimit: element<HTMLSelectElement>("project-preview-limit"),
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
	retryFile: element<HTMLInputElement>("retry-file"),
	importHelp: element("import-help"),
	formatLimits: element("format-limits"),
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
	sourceLabel: element("source-label"),
	duplicateNote: element("duplicate-note"),
	previewDescription: element("preview-description"),
	previewLimit: element<HTMLSelectElement>("preview-limit"),
	profileFootnote: element("profile-footnote"),
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
	pageLimitNote: element("page-limit-note"),
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
	retryImport: element<HTMLButtonElement>("retry-import"),
	openOperation: element<HTMLButtonElement>("open-operation"),
	dismissOperation: element<HTMLButtonElement>("dismiss-operation"),
	announcement: element("announcement"),
	persistenceNote: element("persistence-note"),
	richProfile: element("rich-profile"),
	richProfileStatus: element("rich-profile-status"),
	richProfileError: element("rich-profile-error"),
	runProfile: element<HTMLButtonElement>("run-profile"),
	retryProfile: element<HTMLButtonElement>("retry-profile"),
	profileOverview: element("profile-overview"),
	profileMethod: element<HTMLDetailsElement>("profile-method"),
	profileSampling: element("profile-sampling"),
	profileMetadata: element("profile-metadata"),
	profileLimitations: element("profile-limitations"),
	columnSearch: element<HTMLInputElement>("column-search"),
	columnSearchStatus: element("column-search-status"),
	columnList: element("column-list"),
	columnDetails: element("column-details"),
	statisticsName: element("statistics-dataset-name"),
	statisticsStatus: element("statistics-status"),
	statisticsRich: element("statistics-rich"),
	statisticsColumn: element<HTMLSelectElement>("statistics-column"),
	statisticsDetails: element("statistics-details"),
	statisticsBasis: element("statistics-basis"),
	statisticsBody: element("statistics-body"),
	statisticsPanel: element("statistics-panel"),
	statisticsView: element<HTMLButtonElement>("statistics-view"),
	qualityView: element<HTMLButtonElement>("quality-view"),
	qualityPanel: element("quality-panel"),
	qualitySeverity: element<HTMLSelectElement>("quality-severity"),
	qualitySummary: element("quality-summary"),
	qualityBasis: element("quality-basis"),
	qualityIssues: element("quality-issues"),
};

element("ingestion-statistics").append(ui.profilePanel);
ui.profilePanel.hidden = false;

interface Operation {
	id: string | null;
	job: ImportJob | null;
	kind: ImportJob["kind"];
	name: string;
	projectId: string;
	datasetId: string | null;
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
let maxPreviewRows = MAX_PREVIEW_ROWS;
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
let previewLoading = false;
let profileAbort: AbortController | null = null;
let profileRequestVersion = 0;
let richProfile: DatasetProfile | null = null;
let profileLoading = false;
let profileError = "";
let selectedColumn = 0;
let previewOffset = 0;
let previewLimit = PAGE_SIZE;
let nextOffset = 0;
let pageOffsets: number[] = [0];
let pageIndex = 0;
let requestedPageIndex = 0;
let currentPreview: Preview | null = null;
let operation: Operation | null = null;
let pendingRetry: Operation | null = null;
let chartBusy = false;
const chartStudio = initializeChartStudio(element("chart-studio"), {
	api,
	message,
	onBusy(busy) {
		chartBusy = busy;
		updateControls();
	},
	onProfile() {
		ui.runProfile.scrollIntoView?.({ block: "center" });
		ui.runProfile.focus();
	},
	onContextChange() {
		const context = currentAssistantContext();
		if (context) assistant.update(context);
	},
});
const assistant = initializeAssistant(element("assistant-workspace"), element("assistant-suggestions"), {
	api,
	message,
	currentContext: currentAssistantContext,
	onProfile() {
		ui.runProfile.scrollIntoView?.({ block: "center" });
		ui.runProfile.focus();
	},
	onSuggestions() {
		shell.selectRight("suggestions", true);
	},
	onOpenChart(spec) {
		chartStudio.applySpec(spec);
		shell.selectCenter("visualize", true);
	},
	onPrivacy(state, detail) {
		element("assistant-privacy-state").textContent = state;
		element("assistant-privacy-detail").textContent = detail;
	},
});

function currentAssistantContext(): AssistantUiContext | null {
	if (!projectId || !dataset) return null;
	const selection = chartStudio.getSelection();
	return {
		projectId,
		dataset,
		profile: richProfile,
		selectedColumns: [
			...new Set([
				...selection.selectedColumns,
				...(dataset.schema.some((column) => column.index === selectedColumn) ? [selectedColumn] : []),
			]),
		].sort((a, b) => a - b),
		filters: selection.filters,
		revision: selection.revision,
	};
}
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
function jobPath(owner: string, id: string): string {
	return `/api/projects/${encodeURIComponent(owner)}/imports/${encodeURIComponent(id)}`;
}
function operationActive(): boolean {
	return operation !== null && !operation.finalized;
}
function updateControls(): void {
	ui.projectSelect.disabled = !ready || projects.length === 0;
	ui.projectName.disabled = !ready || creatingProject;
	ui.projectDescriptionInput.disabled = !ready || creatingProject;
	ui.projectPreviewLimit.disabled = !ready || creatingProject;
	ui.createProject.disabled = !ready || creatingProject;
	ui.createProject.textContent = creatingProject ? "Creating…" : "Create project";
	ui.importButton.disabled = !ready || projectId === null || operationActive() || chartBusy;
	ui.emptyAction.disabled = !ready || chartBusy || (projectId !== null && (operationActive() || listingDatasets));
	ui.recompute.disabled = !ready || dataset === null || operationActive() || chartBusy;
	ui.runProfile.disabled =
		!ready || dataset === null || operationActive() || previewLoading || profileLoading || chartBusy;
	ui.retryProfile.disabled = !ready || operationActive() || previewLoading || profileLoading || chartBusy;
	ui.previewLimit.disabled = !ready || dataset === null || chartBusy;
	ui.retryImport.disabled = !ready || operationActive() || chartBusy;
	ui.retryPreview.disabled = chartBusy;
	ui.previousPage.disabled = chartBusy || previewLoading || currentPreview === null || pageIndex === 0;
	ui.nextPage.disabled =
		chartBusy ||
		previewLoading ||
		currentPreview === null ||
		nextOffset >= currentPreview.total ||
		currentPreview.rows.length === 0;
	chartStudio.setBlocked(!ready || operationActive() || previewLoading || profileLoading);
	assistant.setBlocked(!ready || operationActive() || previewLoading || profileLoading || chartBusy);
}

function previewRowLimit(preferred: number): number {
	return Math.min(preferred, maxPreviewRows);
}

function renderPreviewLimits(select: HTMLSelectElement, preferred: number): number {
	const selected = previewRowLimit(preferred);
	const limits = [...new Set([25, PAGE_SIZE, MAX_PREVIEW_ROWS, maxPreviewRows, selected])]
		.filter((limit) => limit <= maxPreviewRows)
		.sort((a, b) => a - b);
	select.replaceChildren(
		...limits.map((limit) => {
			const option = node("option", select === ui.projectPreviewLimit ? `${count(limit)} rows` : count(limit));
			option.value = String(limit);
			option.defaultSelected = limit === selected;
			return option;
		}),
	);
	select.value = String(selected);
	return selected;
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
			node(
				"span",
				`${item.format.toUpperCase()} · ${count(item.rowCount)} rows · ${count(item.columnCount)} cols`,
				"dataset-link-meta",
			),
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
	ui.datasetListStatus.textContent = "No datasets yet. Import CSV or Parquet to get started.";
	updateDatasetSelection();
}

function renderEmpty(): void {
	ui.empty.hidden = false;
	if (projectId === null) {
		ui.emptyTitle.textContent = "A place to understand your data.";
		ui.emptyDescription.textContent =
			"Create a project, import CSV or Parquet, and inspect the source rows alongside reproducible column statistics.";
		ui.emptyAction.textContent = "Create your first project";
	} else {
		ui.emptyTitle.textContent = "Start with the original data.";
		ui.emptyDescription.textContent =
			"Import CSV or Parquet into this project. Explore its rows, inspect every column, and keep a verifiable record of the source.";
		ui.emptyAction.textContent = "Choose a dataset file";
	}
	updateControls();
}

function resetDataset(): void {
	assistant.clear();
	chartStudio.clear();
	datasetVersion++;
	previewVersion++;
	datasetAbort?.abort();
	previewAbort?.abort();
	previewLoading = false;
	ui.previewPanel.setAttribute("aria-busy", "false");
	profileRequestVersion++;
	profileAbort?.abort();
	richProfile = null;
	profileLoading = false;
	profileError = "";
	selectedColumn = 0;
	ui.columnSearch.value = "";
	ui.qualitySeverity.value = "all";
	ui.richProfile.hidden = true;
	ui.profileOverview.replaceChildren();
	ui.columnList.replaceChildren();
	ui.columnDetails.replaceChildren();
	ui.statisticsDetails.replaceChildren();
	ui.statisticsBody.replaceChildren();
	ui.qualityIssues.replaceChildren();
	dataset = null;
	shell.setDatasetAvailable(false);
	datasetId = null;
	previewOffset = 0;
	nextOffset = 0;
	pageOffsets = [0];
	pageIndex = 0;
	requestedPageIndex = 0;
	currentPreview = null;
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
	const selected = projects.find((project) => project.id === id);
	ui.projectHeading.textContent = selected?.name ?? "Project";
	ui.projectDescription.textContent = selected?.description || "Explore original data. Inspect reproducible profiles.";
	previewLimit = renderPreviewLimits(ui.previewLimit, selected?.settings.previewRowLimit ?? PAGE_SIZE);
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
		if (request !== datasetVersion || projectId !== owner || datasetId !== id) return;
		void loadRichProfile();
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
	ui.sourceLabel.textContent = `${value.format.toUpperCase()} / ORIGINAL`;
	ui.duplicateNote.hidden = !value.duplicateOf;
	ui.duplicateNote.textContent = value.duplicateOf
		? `The same source bytes already exist in this project as ${datasets.find((item) => item.id === value.duplicateOf)?.name ?? value.duplicateOf}. This import has its own dataset and version history; the earlier dataset is unchanged.`
		: "";
	ui.previewDescription.textContent =
		value.format === "csv"
			? "Original CSV strings, including whitespace and leading zeros. Basic types are inferred; source types are unchanged."
			: "Parquet values rendered as DuckDB text. Exact integer and decimal text is preserved; nested values use DuckDB text notation. Headers show basic and native types.";
	ui.profileFootnote.textContent =
		value.format === "csv"
			? "Empty means an empty string; whitespace is preserved. Numeric counts and ranges include the finite numeric subset, even in mixed-type columns. A dash means no numeric values."
			: "Empty counts nulls only, not empty strings. Numeric counts cover finite native numeric values; ranges are shown only for finite floating-point or safe integer values. Decimal ranges are not approximated. A dash means no safely represented range; exact values and native types remain available in Preview.";
	const header = node("tr");
	const rowNumber = node("th", "Row", "row-number");
	rowNumber.scope = "col";
	header.append(rowNumber);
	for (const column of value.schema) {
		const heading = node("th");
		heading.scope = "col";
		heading.title = `${column.name} · ${column.basicType} · ${column.sourceType}`;
		heading.append(
			node("span", column.name),
			node("span", `${column.basicType} · ${column.sourceType}`, "schema-type"),
		);
		header.append(heading);
	}
	const profiles = document.createDocumentFragment();
	for (const column of value.columns) {
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
		["Source file", value.originalFilename],
		["Format", value.format.toUpperCase()],
		["Dataset ID", value.id],
		["Imported", date(value.createdAt)],
		["Updated", date(value.updatedAt)],
		["Source size", `${count(value.byteSize)} bytes`],
		["SHA-256", value.sha256],
		["Original storage", value.storageLocation],
		["Source version", value.sourceVersionId],
		["Current version", value.currentVersionId],
		["Schema version", String(value.schemaVersion)],
		[
			"Parsing",
			value.parsing.format === "csv"
				? `${value.parsing.encoding.toUpperCase()} · delimiter ${JSON.stringify(value.parsing.delimiter)} · first row is header`
				: "Parquet native schema · DuckDB text values · nested values use DuckDB text notation",
		],
		[
			"Empty values",
			value.format === "csv"
				? "Empty strings only; whitespace and original values are preserved"
				: "NULL is missing; an empty string remains a separate value",
		],
		["Profile method", `Deterministic full-file scan · version ${value.profileVersion}`],
		[
			"Type inference",
			value.format === "csv"
				? "All nonempty finite decimal/exponent values: number. All true/false: boolean. No nonempty values: empty. Otherwise: text. Native schema types are shown separately in Preview."
				: "Basic and native types come from the Parquet schema. Numeric profile ranges exclude values that cannot be represented safely; exact text remains in Preview.",
		],
		["Last profiled", date(value.profiledAt)],
	];
	for (const version of value.versions) {
		facts.push([
			`${version.kind === "source" ? "Source" : "Derived"} version record`,
			`${version.id} · ${date(version.createdAt)} · ${version.operation.kind} by ${version.operation.engine} ${version.operation.version} · parent: ${version.parentVersionId ?? "none (original upload)"} · storage: ${version.storageLocation}`,
		]);
	}
	if (value.duplicateOf) facts.push(["Same-project duplicate of", value.duplicateOf]);
	const provenance = document.createDocumentFragment();
	for (const [label, detail] of facts) provenance.append(node("dt", label), node("dd", detail));
	ui.provenance.replaceChildren(provenance);
	ui.statisticsName.textContent = value.name;
	renderRichProfile();
	updateControls();
}

function showView(view: View): void {
	currentView = view;
	ui.previewPanel.hidden = view === "provenance";
	ui.provenancePanel.hidden = view !== "provenance";
	ui.previewView.setAttribute("aria-pressed", String(view !== "provenance"));
	ui.provenanceView.setAttribute("aria-pressed", String(view === "provenance"));
}

function percent(value: number | null): string {
	return value === null ? "not available" : `≈ ${count(value)}%`;
}

function profileBasis(profile: DatasetProfile): string {
	return profile.sampling.sampleSize === profile.sampling.populationRows
		? `Full scan · ${count(profile.sampling.sampleSize)} rows`
		: `Sample only · ${count(profile.sampling.sampleSize)} of ${count(profile.sampling.populationRows)} population rows`;
}

function facts(entries: [string, string][]): HTMLDListElement {
	const result = node("dl", undefined, "profile-facts");
	for (const [label, value] of entries) result.append(node("dt", label), node("dd", value));
	return result;
}

function renderRichProfileStatus(): void {
	if (!dataset) return;
	const active =
		operation?.kind === "profile" &&
		operation.datasetId === datasetId &&
		operation.projectId === projectId &&
		!operation.finalized;
	const status = active
		? "Profiling in the background. Progress, Check status and Cancel are available above. Source rows remain available."
		: profileLoading
			? "Loading saved profile for this dataset version…"
			: richProfile
				? `Saved profile · ${date(richProfile.profiledAt)} · profiler v${richProfile.profilerVersion}. Run profile reuses this cache when the dataset version and artifact hash match.`
				: "No rich profile loaded. Run profile explicitly to compute local statistics and data-quality findings. Ingestion statistics and original rows remain available.";
	ui.richProfileStatus.textContent = status;
	ui.statisticsStatus.textContent = richProfile
		? "Observed statistics, not transformations. Inspect a column beside its original rows to investigate."
		: status;
	ui.richProfileError.textContent = profileError;
	ui.richProfileError.hidden = !profileError;
	ui.retryProfile.hidden = !profileError;
	ui.richProfile.setAttribute("aria-busy", String(Boolean(profileLoading || active)));
	ui.runProfile.textContent = active ? "Profiling…" : "Run profile";
	if (!richProfile) ui.qualitySummary.textContent = status;
}

function renderRichProfile(): void {
	if (!dataset) return;
	if (projectId) chartStudio.update({ projectId, dataset, profile: richProfile });
	ui.richProfile.hidden = false;
	renderRichProfileStatus();
	const overview: [string, string, string][] = [
		["Rows", count(dataset.rowCount), "Exact population count"],
		["Columns", count(dataset.columnCount), "Exact schema count"],
		["Source size", bytes(dataset.byteSize), `${count(dataset.byteSize)} bytes · exact`],
	];
	if (richProfile) {
		overview.push(
			["Analytical storage", bytes(richProfile.storageBytes), `${count(richProfile.storageBytes)} bytes · exact`],
			["Estimated memory", `≈ ${bytes(richProfile.estimatedMemoryBytes)}`, "Approximate even on a full scan"],
			[
				"Duplicate rows",
				count(richProfile.duplicateCount),
				`Observed in ${count(richProfile.sampling.sampleSize)} ${richProfile.sampling.sampleSize === richProfile.sampling.populationRows ? "full-scan rows" : "sample rows, not population"}`,
			],
		);
	}
	ui.profileOverview.replaceChildren(
		...overview.map(([label, value, basis]) => {
			const card = node("div", undefined, "overview-card");
			card.append(node("dt", label), node("dd", value), node("span", basis, "muted"));
			return card;
		}),
	);
	ui.profileMethod.hidden = !richProfile;
	ui.statisticsRich.hidden = !richProfile;
	ui.statisticsColumn.replaceChildren(
		...dataset.schema.map((column) => {
			const option = node("option", column.name);
			option.value = String(column.index);
			return option;
		}),
	);
	if (richProfile) {
		const profile = richProfile;
		ui.profileSampling.textContent = `${profileBasis(profile)}. Method: ${profile.sampling.method}; stride ${count(profile.sampling.stride)}; byte limit ${profile.sampling.byteLimited ? "reached" : "not reached"}; sampling approximation flag: ${profile.sampling.approximate ? "yes" : "no"}. Nulls, empty strings, distinct values, top-value frequencies and duplicates describe only the profiled rows. Sample counts are never extrapolated to the population. Numeric arithmetic is floating-point approximate even on a full scan; memory is an estimate; displayed percentages are rounded.`;
		ui.profileMetadata.replaceChildren(
			...facts([
				["Profiled at", date(profile.profiledAt)],
				["Profiler version", String(profile.profilerVersion)],
				["Dataset version", profile.datasetVersionId],
				["Artifact SHA-256", profile.datasetVersionHash],
			]).children,
		);
		ui.profileLimitations.replaceChildren(...profile.limitations.map((text) => node("li", text)));
		ui.statisticsBasis.textContent = `${profileBasis(profile)}. Every count and percentage below is scoped to these rows. Null percentages use all profiled rows; distinct percentages use non-null profiled rows (including empty strings). Percentages are rounded; semantic types are heuristic candidates, not declared types.`;
		ui.statisticsBody.replaceChildren(
			...profile.columns.map((column) => {
				const row = node("tr");
				const label = node("th");
				label.scope = "row";
				const button = node("button", column.name, "column-table-button");
				button.type = "button";
				button.addEventListener("click", () => {
					selectColumn(column.index);
					ui.statisticsColumn.focus();
				});
				label.append(button);
				row.append(
					label,
					node("td", column.originalType),
					node("td", column.semanticTypes.map((candidate) => candidate.type).join(", ") || "None"),
					node(
						"td",
						`${count(column.nullCount)} / ${count(profile.sampling.sampleSize)} (${percent(column.nullPercentage)})`,
					),
					node("td", `${count(column.distinctCount)} (${percent(column.distinctPercentage)} of non-null rows)`),
				);
				return row;
			}),
		);
	} else {
		ui.statisticsBody.replaceChildren();
		ui.profileSampling.textContent = "";
		ui.profileMetadata.replaceChildren();
		ui.profileLimitations.replaceChildren();
	}
	renderColumnList();
	selectColumn(selectedColumn);
	renderQualityIssues();
}

function renderColumnList(): void {
	if (!dataset) return;
	const words = ui.columnSearch.value.trim().toLowerCase().split(/\s+/);
	const columns = dataset.schema.filter((column) => {
		const candidates = richProfile?.columns.find((profile) => profile.index === column.index)?.semanticTypes ?? [];
		const searchable =
			`${column.name} ${column.sourceType} ${column.basicType} ${candidates.map((candidate) => candidate.type).join(" ")}`.toLowerCase();
		return words.every((word) => searchable.includes(word));
	});
	ui.columnSearchStatus.textContent = columns.length
		? `${count(columns.length)} of ${count(dataset.columnCount)} columns · ↑ ↓ to navigate`
		: "No matching columns. Clear the search or try a type.";
	ui.columnList.replaceChildren(
		...columns.map((column) => {
			const item = node("li");
			const button = node("button", undefined, "column-option");
			button.type = "button";
			button.dataset.columnIndex = String(column.index);
			button.setAttribute("aria-pressed", String(column.index === selectedColumn));
			button.setAttribute("aria-controls", "column-details");
			button.append(node("span", column.name), node("span", column.sourceType, "muted"));
			button.addEventListener("click", () => selectColumn(column.index));
			item.append(button);
			return item;
		}),
	);
}

function selectColumn(index: number): void {
	if (!dataset) return;
	const column = dataset.schema.find((item) => item.index === index) ?? dataset.schema[0];
	if (!column) return;
	selectedColumn = column.index;
	ui.statisticsColumn.value = String(selectedColumn);
	for (const button of ui.columnList.querySelectorAll<HTMLButtonElement>("button"))
		button.setAttribute("aria-pressed", String(Number(button.dataset.columnIndex) === selectedColumn));
	const profile = richProfile?.columns.find((item) => item.index === selectedColumn);
	for (const target of [ui.columnDetails, ui.statisticsDetails]) {
		target.replaceChildren(node("h3", column.name));
		if (profile && richProfile) renderColumnDetails(target, profile, richProfile);
		else
			target.append(
				facts([
					["Original type", column.sourceType],
					["Basic type", column.basicType],
				]),
				node(
					"p",
					"Run profile for semantic candidates, distributions and numeric statistics. No rich statistics have been computed for this view.",
					"muted",
				),
			);
	}
	for (const cell of ui.previewHead.querySelectorAll<HTMLTableCellElement>("th")) {
		if (cell.cellIndex === selectedColumn + 1) cell.setAttribute("data-selected-column", "true");
		else cell.removeAttribute("data-selected-column");
	}
	const context = currentAssistantContext();
	if (context) assistant.update(context);
}

function renderColumnDetails(target: HTMLElement, column: ColumnProfile, profile: DatasetProfile): void {
	target.append(node("p", profileBasis(profile), "profile-basis"));
	target.append(
		facts([
			["Original type", column.originalType],
			[
				"Nulls",
				`${count(column.nullCount)} / ${count(profile.sampling.sampleSize)} rows (${percent(column.nullPercentage)})`,
			],
			["Empty strings", `${count(column.emptyStringCount)} · separate from nulls`],
			[
				"Distinct values",
				`${count(column.distinctCount)} (${percent(column.distinctPercentage)} of ${count(profile.sampling.sampleSize - column.nullCount)} non-null profiled rows, including empty strings)`,
			],
		]),
	);
	target.append(node("h4", "Semantic candidates"));
	const candidates = node("ul", undefined, "semantic-candidates");
	for (const candidate of column.semanticTypes)
		candidates.append(
			node(
				"li",
				`${candidate.type} · confidence ${candidate.confidence} (${percent(candidate.confidence * 100)}) · ${candidate.reason}`,
			),
		);
	if (!column.semanticTypes.length) candidates.append(node("li", "No supported semantic candidate."));
	target.append(candidates, node("h4", "Redacted examples"));
	const examples = node("ul", undefined, "redacted-values");
	for (const example of column.examples) examples.append(node("li", example));
	if (!column.examples.length) examples.append(node("li", "No nonmissing examples available."));
	target.append(
		examples,
		node("h4", "Top values (redacted)"),
		node(
			"p",
			`Frequencies observed in ${count(profile.sampling.sampleSize)} ${profile.sampling.sampleSize === profile.sampling.populationRows ? "full-scan rows" : "sample rows, not population"}. Labels are redacted, not original cell values.`,
			"muted",
		),
	);
	const topValues = node("ul", undefined, "top-values");
	for (const value of column.topValues) {
		const item = node("li");
		item.append(node("span", value.label), node("span", `${count(value.count)} rows`, "numeric"));
		topValues.append(item);
	}
	if (!column.topValues.length) topValues.append(node("li", "No top values available."));
	target.append(topValues, node("h4", "Numeric statistics"));
	if (column.numeric) {
		const numeric = column.numeric;
		const approximation = (value: number | null) => (value === null ? "Not available" : `≈ ${String(value)}`);
		target.append(
			node(
				"p",
				"Floating-point approximations, including min/max and quantiles, even on a full scan. Counts describe the profiled rows only.",
				"profile-basis",
			),
			facts([
				["Finite numeric values", count(numeric.count)],
				["Excluded values", count(numeric.excludedCount)],
				["Minimum", approximation(numeric.min)],
				["Maximum", approximation(numeric.max)],
				["Mean", approximation(numeric.mean)],
				["Median (50%)", approximation(numeric.median)],
				["Standard deviation", approximation(numeric.standardDeviation)],
				["5% quantile", approximation(numeric.quantiles.p05)],
				["25% quantile", approximation(numeric.quantiles.p25)],
				["75% quantile", approximation(numeric.quantiles.p75)],
				["95% quantile", approximation(numeric.quantiles.p95)],
				["Skewness", approximation(numeric.skewness)],
				["Outlier candidates", `${count(numeric.outlierCount)} rows · approximate numeric fences`],
				["Lower fence", approximation(numeric.lowerFence)],
				["Upper fence", approximation(numeric.upperFence)],
			]),
		);
	} else target.append(node("p", "Not applicable: no supported finite numeric subset.", "muted"));
	if (column.limitations.length) {
		const limitations = node("ul");
		limitations.append(...column.limitations.map((text) => node("li", text)));
		target.append(node("h4", "Column limitations"), limitations);
	}
}

function renderQualityIssues(): void {
	ui.qualityIssues.replaceChildren();
	ui.qualityBasis.textContent = "";
	if (!richProfile) {
		renderRichProfileStatus();
		return;
	}
	const profile = richProfile;
	const issues = profile.issues.filter(
		(issue) => ui.qualitySeverity.value === "all" || issue.severity === ui.qualitySeverity.value,
	);
	ui.qualitySummary.textContent = issues.length
		? `${count(issues.length)} of ${count(profile.issues.length)} findings · ${ui.qualitySeverity.value === "all" ? "all severities" : ui.qualitySeverity.value}`
		: profile.issues.length
			? "No findings match this severity. Choose All severities to see other findings."
			: "No findings detected by these rules. This is not proof that the dataset is free of quality problems.";
	ui.qualityBasis.textContent = `${profileBasis(profile)}. Heuristic findings require review; proposed actions never change data automatically. Evidence values below retain the reported precision and carry their own basis and approximation flags.`;
	for (const issue of issues) {
		const item = node("li", undefined, "quality-issue");
		item.dataset.severity = issue.severity;
		item.dataset.issueId = issue.id;
		const heading = node("div", undefined, "profile-toolbar");
		heading.append(
			node("h4", issue.title),
			node("span", issue.severity, `severity-label severity-${issue.severity}`),
		);
		item.append(
			heading,
			facts([
				["Rule", `${issue.kind} · ${issue.id}`],
				[
					"Columns",
					issue.columns
						.map(
							(index) => profile.columns.find((column) => column.index === index)?.name ?? `Column ${index + 1}`,
						)
						.join(", ") || "Dataset-wide",
				],
				[
					"Confidence",
					`${issue.confidence} (${percent(issue.confidence * 100)}) · heuristic, not a probability guarantee`,
				],
			]),
		);
		item.append(node("h5", "Reported evidence"));
		const evidenceList = node("ul", undefined, "issue-evidence");
		for (const evidence of issue.evidence) {
			const evidenceItem = node("li");
			evidenceItem.append(
				facts([
					["Metric", evidence.metric],
					["Reported value", evidence.value === null ? "Not available (null)" : String(evidence.value)],
					["Basis", `${evidence.basis} · ${count(evidence.rows)} rows`],
					[
						"Approximate",
						evidence.approximate
							? "Yes — not exact"
							: evidence.basis === "sample"
								? "No — exact within sample only, not population"
								: "No — full-scan evidence",
					],
					["Detail", evidence.detail],
				]),
			);
			evidenceList.append(evidenceItem);
		}
		item.append(evidenceList, node("h5", "Proposed action"), node("p", issue.proposedAction));
		ui.qualityIssues.append(item);
	}
}

function showReportView(quality: boolean): void {
	ui.statisticsPanel.hidden = quality;
	ui.qualityPanel.hidden = !quality;
	ui.statisticsView.setAttribute("aria-pressed", String(!quality));
	ui.qualityView.setAttribute("aria-pressed", String(quality));
}

async function loadRichProfile(): Promise<void> {
	if (!projectId || !datasetId || !dataset) return;
	const owner = projectId;
	const id = datasetId;
	const version = dataset.currentVersionId;
	const request = ++profileRequestVersion;
	profileAbort?.abort();
	const controller = new AbortController();
	profileAbort = controller;
	profileLoading = true;
	profileError = "";
	renderRichProfileStatus();
	updateControls();
	try {
		const response = await api<ProfileResponse>(`${datasetPath(owner, id)}/profile`, { signal: controller.signal });
		if (
			request !== profileRequestVersion ||
			projectId !== owner ||
			datasetId !== id ||
			dataset?.currentVersionId !== version
		)
			return;
		if (
			response.profile &&
			(response.profile.datasetVersionId !== version || response.profile.profilerVersion !== PROFILER_VERSION)
		)
			throw new ApiError(
				"The saved profile does not match this dataset version or profiler. Run profile to calculate a current report.",
				409,
			);
		richProfile = response.profile;
		renderRichProfile();
	} catch (error) {
		if (request !== profileRequestVersion || projectId !== owner || datasetId !== id || isAborted(error)) return;
		profileError = message(error);
	} finally {
		if (request === profileRequestVersion) {
			profileLoading = false;
			renderRichProfileStatus();
			updateControls();
		}
	}
}

async function runRichProfile(): Promise<void> {
	if (!ready || !dataset || !projectId || operationActive() || previewLoading || profileLoading || chartBusy) return;
	const source = dataset;
	const owner = projectId;
	profileError = "";
	const value = newOperation("profile", source.name, owner, 0, source.id);
	try {
		const job = await api<ImportJob>(`${datasetPath(owner, source.id)}/profile`, { method: "POST" });
		applyJob(value, job);
		if (value.cancelRequested && !value.finalized) await cancelOperation(value);
		else schedulePoll(value);
	} catch (error) {
		if (operation !== value || value.finalized) return;
		value.finalized = true;
		value.statusError = message(error);
		renderOperation(value);
	}
}

async function loadPreview(offset: number, index = pageIndex): Promise<void> {
	if (!projectId || !datasetId || !dataset) return;
	if (chartBusy) return;
	const owner = projectId;
	const id = datasetId;
	const request = ++previewVersion;
	previewAbort?.abort();
	const controller = new AbortController();
	previewAbort = controller;
	previewLoading = true;
	updateControls();
	previewOffset = offset;
	requestedPageIndex = index;
	ui.previewPanel.setAttribute("aria-busy", "true");
	ui.previewStatus.hidden = false;
	ui.previewStatus.textContent = "Loading original rows…";
	ui.previewScroll.hidden = currentPreview === null;
	ui.retryPreview.hidden = true;
	ui.previousPage.disabled = true;
	ui.nextPage.disabled = true;
	if (currentPreview === null) {
		ui.pageSummary.textContent = "Loading page…";
		ui.pageLimitNote.hidden = true;
	}
	try {
		const preview = await api<Preview>(`${datasetPath(owner, id)}/preview?offset=${offset}&limit=${previewLimit}`, {
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
				if (value === null) {
					cell.append(node("span", "NULL", "cell-null"));
					cell.setAttribute("aria-label", "Null (missing value)");
				} else if (value === "") {
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
		ui.previewScroll.hidden = false;
		ui.previewStatus.hidden = preview.rows.length > 0;
		ui.previewStatus.textContent =
			"This dataset has no data rows. Its column schema is available in the preview headers and Column profile.";
		currentPreview = preview;
		pageIndex = index;
		pageOffsets = pageOffsets.slice(0, index);
		pageOffsets.push(preview.offset);
		previewOffset = preview.offset;
		nextOffset = preview.offset + preview.rows.length;
		ui.pageSummary.textContent =
			preview.total === 0
				? "0 data rows"
				: `Rows ${count(preview.offset + 1)}–${count(nextOffset)} of ${count(preview.total)} · up to ${count(preview.limit)} per page`;
		ui.previousPage.disabled = pageIndex === 0;
		ui.nextPage.disabled = nextOffset >= preview.total || preview.rows.length === 0;
		ui.pageLimitNote.hidden =
			preview.rows.length === 0 || preview.rows.length >= preview.limit || nextOffset >= preview.total;
		ui.previewScroll.scrollTop = 0;
		announce(ui.pageSummary.textContent);
	} catch (error) {
		if (request !== previewVersion || isAborted(error)) return;
		ui.previewStatus.textContent = currentPreview
			? `${message(error)} The previously loaded page is still shown. Retry to load the requested page.`
			: message(error);
		ui.retryPreview.hidden = false;
		ui.previousPage.disabled = currentPreview === null || pageIndex === 0;
		ui.nextPage.disabled =
			currentPreview === null || nextOffset >= currentPreview.total || currentPreview.rows.length === 0;
		if (currentPreview === null) ui.pageSummary.textContent = "Preview unavailable";
		announce("Could not load the preview. Use Retry preview.");
	} finally {
		if (request === previewVersion) {
			previewLoading = false;
			ui.previewPanel.setAttribute("aria-busy", "false");
			updateControls();
		}
	}
}

function newOperation(
	kind: ImportJob["kind"],
	name: string,
	owner: string,
	totalBytes: number,
	targetDataset: string | null = null,
): Operation {
	const value: Operation = {
		id: null,
		job: null,
		kind,
		name,
		projectId: owner,
		datasetId: targetDataset,
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
	const moveFocus =
		document.activeElement === ui.retryImport ||
		document.activeElement === ui.dismissOperation ||
		document.activeElement === ui.openOperation;
	pendingRetry = null;
	stored("operation", null, true);
	operation = value;
	renderOperation(value);
	if (moveFocus) ui.cancelOperation.focus();
	return value;
}

function rememberOperation(value: Operation): void {
	if (value.id)
		stored(
			"operation",
			JSON.stringify({ id: value.id, projectId: value.projectId, totalBytes: value.totalBytes }),
			true,
		);
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
	const operationLabel =
		value.kind === "import"
			? `${job?.format.toUpperCase() ?? "Dataset"} import`
			: value.kind === "profile"
				? "Deterministic rich profile"
				: "Ingestion statistics recomputation";
	ui.operationContext.textContent = `${operationLabel}${ownerName ? ` / ${ownerName}` : ""}`;
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
	ui.retryImport.hidden =
		!value.finalized || value.kind !== "import" || (job?.state !== "failed" && job?.state !== "cancelled");
	ui.dismissOperation.hidden = !value.finalized;
	ui.openOperation.hidden = job?.state !== "completed" || !job?.datasetId;
	ui.operationProgress.hidden = value.finalized && state !== "completed";
	if (state === "completed") {
		ui.operationProgress.max = 1;
		ui.operationProgress.value = 1;
		ui.operationDetail.textContent =
			value.kind === "import"
				? `${count(job?.rowCount ?? 0)} rows imported. Original source and versioned analytical data saved locally.`
				: value.kind === "profile"
					? "Profile ready. A matching versioned cache is reused when available; source data is unchanged."
					: "Ingestion statistics recomputed from the preserved source.";
	} else if (state === "cancelled") {
		ui.operationDetail.textContent =
			value.kind === "import"
				? "Import cancelled. No dataset was added. Retry import requires choosing the original file again."
				: value.kind === "profile"
					? "Profiling cancelled. Any previously saved rich profile is unchanged."
					: "Recomputation cancelled. The previous ingestion statistics are unchanged.";
	} else if (state === "unavailable") {
		ui.operationDetail.textContent = "The server no longer has a status record for this operation.";
	} else if (state === "failed") {
		ui.operationDetail.textContent =
			value.kind === "import"
				? job
					? "Import failed. Retry import lets you choose the original file again for a new upload; use Import dataset for a different file."
					: "The upload could not be reserved. Check the error, then use Import dataset to choose the file again."
				: value.kind === "profile"
					? "Profiling failed. Any previously saved rich profile is unchanged. Use Run profile to try again."
					: "Recomputation failed. The previous ingestion statistics are unchanged.";
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
	renderRichProfileStatus();
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
		const job = await api<ImportJob>(jobPath(value.projectId, value.id), { signal: controller.signal });
		if (operation !== value || controller.signal.aborted || value.finalized) return;
		value.paused = false;
		value.statusError = "";
		if (value.recovered && job.state === "uploading")
			value.statusError =
				"An interrupted upload cannot resume after reload. Cancel this operation, then use Retry import to choose the original file again.";
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
	if (job.projectId !== value.projectId || (value.id !== null && job.id !== value.id))
		throw new ApiError("The server returned a different operation. Check status before continuing.", 502);
	if (value.job?.state === "processing" && job.state === "uploading") return;
	value.id = job.id;
	value.name = job.name;
	value.kind = job.kind;
	value.datasetId = job.datasetId ?? value.datasetId;
	value.job = job;
	const terminal = job.state === "completed" || job.state === "cancelled" || job.state === "failed";
	const moveFocus = document.activeElement === ui.cancelOperation || document.activeElement === ui.retryOperation;
	if (terminal) {
		value.finalized = true;
		stopPolling(value);
		value.uploadAbort?.abort();
	}
	rememberOperation(value);
	renderOperation(value);
	if (!terminal) return;
	announce(
		`${job.kind === "import" ? "Import" : job.kind === "profile" ? "Rich profile" : "Ingestion statistics recomputation"} ${job.state}: ${job.name}.${job.error ? ` ${job.error}` : ""}`,
	);
	if (moveFocus) ui.dismissOperation.focus();
	if (job.kind === "profile") {
		if (job.state === "completed" && datasetId === job.datasetId && projectId === job.projectId)
			void loadRichProfile();
		return;
	}
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
		const job = await api<ImportJob>(jobPath(value.projectId, value.id), { method: "DELETE" });
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

async function importFile(file: File, previous?: Operation): Promise<void> {
	if (!ready || operationActive() || chartBusy) return;
	const priorJob = previous?.job;
	if (
		previous &&
		(operation !== previous ||
			!priorJob ||
			priorJob.kind !== "import" ||
			(priorJob.state !== "failed" && priorJob.state !== "cancelled"))
	)
		return;
	const owner = previous?.projectId ?? projectId;
	if (!owner) return;
	const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
	const format: DatasetFormat | null = extension === ".csv" ? "csv" : extension === ".parquet" ? "parquet" : null;
	if (!format) {
		showNotice("Choose a .csv or .parquet file. Renaming another format does not convert its contents.");
		return;
	}
	if (priorJob && (file.name !== priorJob.name || format !== priorJob.format)) {
		showNotice(
			`Retry requires the same filename and format: ${priorJob.name} (${priorJob.format.toUpperCase()}). Choose that file again, or use Import dataset to add a different file to the selected project.`,
		);
		return;
	}
	if (file.size === 0) {
		showNotice("This file is empty. Choose CSV with a nonempty header row, or a valid Parquet file.");
		return;
	}
	if (file.size > maxUploadBytes) {
		showNotice(
			`This file is ${bytes(file.size)}. Choose CSV or Parquet no larger than ${bytes(maxUploadBytes)} (${count(maxUploadBytes)} bytes).`,
		);
		return;
	}
	const mimeType = file.type || "application/octet-stream";
	const value = newOperation("import", file.name, owner, file.size);
	try {
		const job = priorJob
			? await api<ImportJob>(`${jobPath(owner, priorJob.id)}/retry`, { method: "POST" })
			: await api<ImportJob>(`/api/projects/${encodeURIComponent(owner)}/imports`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: file.name, mimeType }),
				});
		applyJob(value, job);
		if (value.finalized) return;
		if (value.cancelRequested) {
			await cancelOperation(value);
			return;
		}
		const controller = new AbortController();
		value.uploadAbort = controller;
		schedulePoll(value);
		const uploaded = await api<ImportJob>(`${jobPath(owner, job.id)}/content`, {
			method: "PUT",
			headers: { "Content-Type": mimeType },
			body: file,
			signal: controller.signal,
		});
		applyJob(value, uploaded);
	} catch (error) {
		if (operation !== value || value.finalized || (value.cancelRequested && value.id !== null)) return;
		const detail = message(error);
		if (!value.id) {
			if (previous) {
				operation = previous;
				previous.statusError = `Could not reserve a new upload. ${detail}`;
				rememberOperation(previous);
				renderOperation(previous);
				ui.retryImport.focus();
				return;
			}
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
	if (!ready || !dataset || !projectId || operationActive() || chartBusy) return;
	const source = dataset;
	const owner = projectId;
	const value = newOperation("reprofile", source.name, owner, source.byteSize, source.id);
	try {
		const job = await api<ImportJob>(`${datasetPath(owner, source.id)}/reprofile`, { method: "POST" });
		applyJob(value, job);
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
		parsed.id.length === 0 ||
		!("projectId" in parsed) ||
		typeof parsed.projectId !== "string" ||
		!projects.some((project) => project.id === parsed.projectId) ||
		!("totalBytes" in parsed) ||
		typeof parsed.totalBytes !== "number" ||
		!Number.isFinite(parsed.totalBytes) ||
		parsed.totalBytes < 0
	) {
		stored("operation", null, true);
		showNotice(
			"The saved operation reference is invalid or has no available owner project. It was discarded; your datasets remain on disk.",
		);
		return;
	}
	const value = newOperation("import", "Previous operation", parsed.projectId, parsed.totalBytes);
	value.id = parsed.id;
	value.startSelection = -1;
	value.recovered = true;
	rememberOperation(value);
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
	const description = ui.projectDescriptionInput.value.trim();
	const previewRowLimit = Number(ui.projectPreviewLimit.value);
	creatingProject = true;
	ui.projectError.hidden = true;
	updateControls();
	try {
		const project = await api<Project>("/api/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, description, settings: { previewRowLimit } }),
		});
		projects.push(project);
		renderProjects();
		ui.projectForm.reset();
		ui.createDetails.open = false;
		await selectProject(project.id);
		announce(`Project ${project.name} created. Import CSV or Parquet to begin.`);
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
		maxPreviewRows = initial.maxPreviewRows;
		renderPreviewLimits(ui.previewLimit, PAGE_SIZE);
		renderPreviewLimits(ui.projectPreviewLimit, PAGE_SIZE);
		ui.importHelp.textContent = `CSV or Parquet · Up to ${bytes(maxUploadBytes)} per file · ${bytes(initial.maxDecodedBytes)} decoded`;
		ui.formatLimits.textContent = `Up to ${bytes(maxUploadBytes)} (${count(maxUploadBytes)} bytes) per file, 512 columns, 1 MiB per record, and ${bytes(initial.maxDecodedBytes)} (${count(initial.maxDecodedBytes)} bytes) decoded data. Parquet metadata: 16 MiB footer and 64 MiB uncompressed row group. Processing: 1 GiB worker memory, 512 MiB temporary disk, and 5 minutes. Preview: up to ${count(initial.maxPreviewRows)} rows and 8 MiB per page; wide rows may produce shorter pages. File extension, MIME hint, and content must agree; unsupported or oversized files are rejected, never sampled silently.`;
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
ui.retryImport.addEventListener("click", () => {
	if (
		!operation?.finalized ||
		!operation.job ||
		operation.job.kind !== "import" ||
		(operation.job.state !== "failed" && operation.job.state !== "cancelled")
	)
		return;
	pendingRetry = operation;
	ui.retryFile.click();
});
ui.retryFile.addEventListener("change", () => {
	const file = ui.retryFile.files?.[0];
	const previous = pendingRetry;
	ui.retryFile.value = "";
	pendingRetry = null;
	if (file && previous) void importFile(file, previous);
});
ui.retryFile.addEventListener("cancel", () => {
	pendingRetry = null;
	ui.retryImport.focus();
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
	showReportView(false);
	shell.selectCenter("statistics", true);
});
ui.provenanceView.addEventListener("click", () => {
	showView("provenance");
	shell.selectCenter("data");
});
element("view-quality").addEventListener("click", () => {
	showReportView(true);
	shell.selectCenter("statistics", true);
});
ui.statisticsView.addEventListener("click", () => showReportView(false));
ui.qualityView.addEventListener("click", () => showReportView(true));
ui.runProfile.addEventListener("click", () => {
	void runRichProfile();
});
ui.retryProfile.addEventListener("click", () => {
	void loadRichProfile();
});
ui.columnSearch.addEventListener("input", renderColumnList);
ui.columnSearch.addEventListener("keydown", (event) => {
	if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.key === "Escape") {
		ui.columnSearch.value = "";
		renderColumnList();
	} else if (event.key === "ArrowDown" || event.key === "Enter") {
		event.preventDefault();
		const first = ui.columnList.querySelector<HTMLButtonElement>("button");
		if (first) {
			first.click();
			first.focus();
		}
	}
});
ui.columnList.addEventListener("keydown", (event) => {
	if (event.altKey || event.ctrlKey || event.metaKey) return;
	const buttons = [...ui.columnList.querySelectorAll<HTMLButtonElement>("button")];
	const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
	if (index < 0) return;
	let next: number;
	if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
	else if (event.key === "ArrowUp") next = (index + buttons.length - 1) % buttons.length;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = buttons.length - 1;
	else if (event.key === "Escape") {
		ui.columnSearch.focus();
		return;
	} else return;
	event.preventDefault();
	buttons[next].click();
	buttons[next].focus();
});
ui.statisticsColumn.addEventListener("change", () => selectColumn(Number(ui.statisticsColumn.value)));
ui.qualitySeverity.addEventListener("change", renderQualityIssues);
element("inspect-column").addEventListener("click", () => {
	showView("preview");
	shell.selectCenter("data");
	ui.columnDetails.focus();
});
ui.previewLimit.addEventListener("change", () => {
	previewLimit = previewRowLimit(Number(ui.previewLimit.value));
	ui.previewLimit.value = String(previewLimit);
	void loadPreview(0, 0);
});
ui.previousPage.addEventListener("click", () => {
	if (pageIndex === 0) return;
	void loadPreview(pageOffsets[pageIndex - 1] ?? 0, pageIndex - 1);
});
ui.nextPage.addEventListener("click", () => {
	void loadPreview(nextOffset, pageIndex + 1);
});
ui.retryPreview.addEventListener("click", () => {
	void loadPreview(previewOffset, requestedPageIndex);
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
	stored("operation", null, true);
	pendingRetry = null;
	operation = null;
	ui.operation.hidden = true;
	updateControls();
	ui.importButton.focus();
});
window.addEventListener("beforeunload", (event) => {
	if (operationActive() && (operation?.job?.state === "uploading" || operation?.job === null)) event.preventDefault();
});

void bootstrap();
