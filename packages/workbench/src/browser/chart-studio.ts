import {
	CHART_TYPES,
	type ChartComparison,
	type ChartFilter,
	type ChartRecord,
	type ChartResult,
	type ChartSpec,
	type ChartType,
} from "../chart-contracts.ts";
import { defaultChartSpec, generateChartPython, parseChartSpec, recommendCharts } from "../chart-spec.ts";
import type { Dataset, DatasetColumn } from "../contracts.ts";
import type { DatasetProfile } from "../profile-contracts.ts";
import { exportChart } from "./chart-export.ts";
import { renderChart } from "./chart-renderer.ts";

interface StudioContext {
	projectId: string;
	dataset: Dataset;
	profile: DatasetProfile | null;
}
interface StudioOptions {
	api<T>(path: string, options?: RequestInit): Promise<T>;
	message?(error: unknown): string;
	onProfile(): void;
	onBusy?(busy: boolean): void;
	onContextChange?(): void;
}
export interface ChartStudioController {
	update(context: StudioContext): void;
	clear(): void;
	setBlocked(blocked: boolean): void;
	getSelection(): { selectedColumns: number[]; filters: ChartFilter[]; revision: number };
	applySpec(spec: ChartSpec): void;
	dispose(): void;
}
type Pane = "left" | "right";
type Encoding = "x" | "y" | "color" | "size" | "facet";
const names: Record<ChartType, string> = {
	histogram: "Histogram",
	box: "Box plot",
	bar: "Bar",
	line: "Line",
	scatter: "Scatter",
	heatmap: "Heatmap",
	correlation: "Correlation matrix",
	missingness: "Missingness matrix",
	"model-result": "Model result (not fitted)",
};
const modes: [ChartComparison["mode"], string][] = [
	["single", "Single chart"],
	["data-chart", "Data beside chart"],
	["chart-chart", "Two charts"],
	["filtered", "Two filtered variants"],
];
const operators: [ChartFilter["op"], string][] = [
	["eq", "Equals"],
	["neq", "Does not equal"],
	["contains", "Contains"],
	["gt", "Greater than"],
	["gte", "At least"],
	["lt", "Less than"],
	["lte", "At most"],
	["is-null", "Is null"],
	["not-null", "Is not null"],
];
const encodings: Encoding[] = ["x", "y", "color", "size", "facet"];

export function initializeChartStudio(container: HTMLElement, options: StudioOptions): ChartStudioController {
	const document = container.ownerDocument;
	const window = document.defaultView!;
	let context: StudioContext | null = null;
	let state: ChartComparison | null = null;
	let active: Pane = "left";
	let blocked = false;
	let busy = false;
	let saving = false;
	let disposed = false;
	let generation = 0;
	let contextRevision = 0;
	let renderSequence = 0;
	let renderAbort: AbortController | null = null;
	let listAbort: AbortController | null = null;
	let saveAbort: AbortController | null = null;
	let listed = false;
	let skipNextVisibleList = false;
	let records: ChartRecord[] = [];
	let selectedId = "";
	let selectedRows = new Set<number>();
	const results: Record<Pane, ChartResult | null> = { left: null, right: null };
	const painted: Record<Pane, ChartResult | null> = { left: null, right: null };
	const exportBusy: Record<Pane, boolean> = { left: false, right: false };
	const errors: Record<Pane, string> = { left: "", right: "" };

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
	function button(id: string, text: string, action: () => void, primary = false): HTMLButtonElement {
		const result = node("button", text, `button${primary ? " button-primary" : ""}`);
		result.id = id;
		result.type = "button";
		result.addEventListener("click", action);
		return result;
	}
	function select(id: string, values: readonly (readonly [string, string])[]): HTMLSelectElement {
		const result = node("select");
		result.id = id;
		setOptions(result, values);
		return result;
	}
	function setOptions(target: HTMLSelectElement, values: readonly (readonly [string, string])[]): void {
		target.replaceChildren(
			...values.map(([value, label]) => {
				const option = node("option", label);
				option.value = value;
				return option;
			}),
		);
	}
	function labeled(text: string, control: HTMLElement): HTMLDivElement {
		const field = node("div", undefined, "chart-control");
		const label = node("label", text);
		label.htmlFor = control.id;
		field.append(label, control);
		return field;
	}
	function input(id: string, type = "text"): HTMLInputElement {
		const result = node("input");
		result.id = id;
		result.type = type;
		return result;
	}
	function status(id: string, alert = false): HTMLParagraphElement {
		const result = node("p", undefined, alert ? "inline-error" : "table-footnote");
		result.id = id;
		result.setAttribute("role", alert ? "alert" : "status");
		return result;
	}
	const heading = node("div", undefined, "profile-toolbar");
	const title = node("div", undefined, "heading-copy");
	const datasetName = node("h2", "Visualization studio");
	title.append(node("p", "Deterministic / local / original data unchanged", "eyebrow"), datasetName);
	const renderButton = button(
		"chart-render",
		"Render chart",
		() => {
			void run();
		},
		true,
	);
	const cancelButton = button("chart-cancel", "Cancel render", cancelRender);
	const renderActions = node("div", undefined, "button-row");
	renderActions.append(renderButton, cancelButton);
	heading.append(title, renderActions);
	const gate = node("div", undefined, "chart-gate");
	const gateText = node("p");
	const profileButton = button("chart-profile-direction", "Find Run profile", options.onProfile);
	gate.append(gateText, profileButton);
	const feedback = status("chart-status");
	const storageNote = status("chart-storage-note");
	storageNote.className = "storage-note";
	storageNote.hidden = true;
	const workspace = node("div", undefined, "chart-workspace");
	const fieldBrowser = node("aside", undefined, "chart-field-browser");
	fieldBrowser.setAttribute("aria-label", "Chart field browser");
	const search = input("chart-field-search", "search");
	search.placeholder = "Name, type, semantic or cardinality";
	search.setAttribute("aria-controls", "chart-fields");
	const assign = select(
		"chart-field-target",
		encodings.map((key) => [key, key === "size" ? "Size / cell measure" : key.toUpperCase()]),
	);
	const fieldStatus = status("chart-field-status");
	const fields = node("ul", undefined, "column-list chart-fields");
	fields.id = "chart-fields";
	fieldBrowser.append(labeled("Search fields", search), labeled("Use selected field as", assign), fieldStatus, fields);
	const main = node("div", undefined, "chart-main");
	const comparison = node("div", undefined, "chart-comparison-controls");
	const mode = select("chart-mode", modes);
	const paneSelect = select("chart-active-pane", [
		["left", "Left chart"],
		["right", "Right chart"],
	]);
	const comparisonNote = node("p", undefined, "muted");
	comparison.append(labeled("Compare", mode), labeled("Editing", paneSelect), comparisonNote);
	const recommendations = node("details", undefined, "chart-disclosure");
	const recommendationList = node("ul", undefined, "chart-recommendations");
	recommendationList.id = "chart-recommendations";
	recommendations.append(node("summary", "Recommended from this profile"), recommendationList);
	const editor = node("fieldset", undefined, "chart-editor");
	editor.append(node("legend", "Chart specification"));
	const controls = node("div", undefined, "chart-control-grid");
	const chartType = select(
		"chart-type",
		CHART_TYPES.map((type) => [type, names[type]]),
	);
	const encodingControls = Object.fromEntries(encodings.map((key) => [key, select(`chart-${key}`, [])])) as Record<
		Encoding,
		HTMLSelectElement
	>;
	const aggregation = select("chart-aggregation", []);
	const sort = select("chart-sort", [
		["ascending", "Axis ascending"],
		["descending", "Axis descending"],
		["value-descending", "Largest value first"],
	]);
	const bins = input("chart-bins", "number");
	bins.min = "5";
	bins.max = "100";
	bins.step = "1";
	const categoryLimit = input("chart-category-limit", "number");
	categoryLimit.min = "1";
	categoryLimit.max = "30";
	categoryLimit.step = "1";
	const zeroBaseline = input("chart-zero-baseline", "checkbox");
	const xMin = input("chart-x-min", "number");
	xMin.step = "any";
	xMin.placeholder = "Automatic";
	const yMin = input("chart-y-min", "number");
	yMin.step = "any";
	yMin.placeholder = "Automatic";
	const sizeField = labeled("Size", encodingControls.size);
	controls.append(
		labeled("Chart type", chartType),
		labeled("X", encodingControls.x),
		labeled("Y", encodingControls.y),
		labeled("Color (max 10 groups)", encodingControls.color),
		sizeField,
		labeled("Facet (max 4 panels)", encodingControls.facet),
		labeled("Aggregation", aggregation),
		labeled("Sort", sort),
		labeled("Histogram bins", bins),
		labeled("Category limit (max 30)", categoryLimit),
	);
	const advanced = node("details", undefined, "chart-disclosure");
	const axisControls = node("div", undefined, "chart-control-grid");
	axisControls.append(
		labeled("Zero numeric baseline", zeroBaseline),
		labeled("X minimum", xMin),
		labeled("Y minimum", yMin),
	);
	advanced.append(node("summary", "Axis bounds and baseline"), axisControls);
	const controlNote = node("p", undefined, "table-footnote");
	const validation = status("chart-validation", true);
	const safeguards = node("p", undefined, "profile-basis");
	safeguards.id = "chart-safeguards";
	const filterHeading = node("div", undefined, "profile-toolbar");
	const addFilter = button("chart-add-filter", "Add filter", () => {
		if (!state || !context || state[active].filters.length >= 8) return;
		const column = scalarColumns()[0];
		if (!column) return;
		state[active].filters.push({ column: column.index, op: "eq", value: "" });
		changed(false);
		renderFilters();
		filterList.lastElementChild?.querySelector<HTMLSelectElement>("select")?.focus();
	});
	filterHeading.append(node("h3", "Filters · all conditions must match"), addFilter);
	const filterList = node("div", undefined, "chart-filters");
	filterList.id = "chart-filters";
	editor.append(controls, controlNote, advanced, safeguards, filterHeading, filterList, validation);
	const saved = node("details", undefined, "chart-disclosure chart-saved");
	const savedSelect = select("chart-saved-list", [["", "Choose a saved chart"]]);
	const chartName = input("chart-name");
	chartName.maxLength = 120;
	chartName.placeholder = "e.g. Distribution by region";
	const savedActions = node("div", undefined, "button-row");
	const loadButton = button("chart-load", "Load into active pane", loadSaved);
	const saveNew = button("chart-save-new", "Save new", () => {
		void mutate("new");
	});
	const updateSaved = button("chart-save-update", "Update saved", () => {
		void mutate("update");
	});
	const duplicate = button("chart-duplicate", "Duplicate saved", () => {
		void mutate("duplicate");
	});
	const rename = button("chart-rename", "Rename saved", () => {
		void mutate("rename");
	});
	const deleteButton = button("chart-delete", "Delete saved…", () => {
		const record = records.find((item) => item.id === selectedId);
		if (!record) return;
		deleteText.textContent = `Delete chart configuration “${record.name}”? Original data will not be modified.`;
		deleteConfirmation.hidden = false;
		confirmDelete.focus();
	});
	const refresh = button("chart-refresh-saved", "Reload saved charts", () => {
		listed = false;
		void loadList();
	});
	savedActions.append(loadButton, saveNew, updateSaved, duplicate, rename, deleteButton, refresh);
	const savedStatus = status("chart-saved-status");
	const savedError = status("chart-saved-error", true);
	const deleteConfirmation = node("div", undefined, "chart-delete-confirmation");
	deleteConfirmation.hidden = true;
	const deleteText = node("p");
	const confirmDelete = button("chart-confirm-delete", "Delete configuration", () => {
		void mutate("delete");
	});
	const dismissDelete = button("chart-dismiss-delete", "Keep configuration", () => {
		deleteConfirmation.hidden = true;
		deleteButton.focus();
	});
	deleteConfirmation.append(deleteText, confirmDelete, dismissDelete);
	saved.append(
		node("summary", "Saved chart configurations"),
		labeled("Saved charts", savedSelect),
		labeled("Configuration name", chartName),
		savedActions,
		savedStatus,
		savedError,
		deleteConfirmation,
	);
	const canvases = node("div", undefined, "chart-canvases");
	canvases.id = "chart-canvases";
	const paneElements = { left: createPane("left"), right: createPane("right") };
	const tablePanel = node("section", undefined, "chart-data-panel");
	tablePanel.setAttribute("aria-label", "Rows behind the left chart");
	const selectionStatus = status("chart-selection-status");
	const clearSelection = button("chart-clear-selection", "Clear selection", () => {
		selectedRows.clear();
		painted.left = null;
		renderTable();
		paint("left");
	});
	const tableScroll = node("div", undefined, "table-scroll");
	tableScroll.id = "chart-table-scroll";
	tableScroll.tabIndex = 0;
	tableScroll.setAttribute("role", "region");
	tableScroll.setAttribute("aria-label", "Scrollable chart source rows");
	tablePanel.append(
		node("h3", "Rows behind the chart"),
		node(
			"p",
			"First 100 filtered sample rows · original row numbers · referenced fields only. Select a chart mark to highlight matching visible rows.",
			"table-footnote",
		),
		selectionStatus,
		clearSelection,
		tableScroll,
	);
	canvases.append(tablePanel, paneElements.left.section, paneElements.right.section);
	main.append(comparison, recommendations, editor, saved, canvases);
	workspace.append(fieldBrowser, main);
	container.replaceChildren(heading, gate, feedback, storageNote, workspace);
	const panel = container.closest<HTMLElement>("[role='tabpanel']") ?? container;
	const visibility = new window.MutationObserver(() => {
		if (!panel.hidden) {
			if (skipNextVisibleList) skipNextVisibleList = false;
			else void loadList();
		}
	});
	visibility.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
	const theme = new window.MutationObserver(() => {
		selectedRows.clear();
		for (const pane of ["left", "right"] as const) {
			painted[pane] = null;
			if (results[pane]) paint(pane);
		}
		renderTable();
	});
	theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

	function createPane(pane: Pane) {
		const section = node("section", undefined, "chart-pane");
		section.id = `chart-pane-${pane}`;
		section.setAttribute("aria-label", `${pane === "left" ? "Left" : "Right"} chart result`);
		const heading = node("h3", `${pane === "left" ? "Left" : "Right"} chart`);
		const error = status(`chart-error-${pane}`, true);
		const canvas = node("div", undefined, "chart-canvas");
		canvas.id = `chart-canvas-${pane}`;
		const metadata = node("dl", undefined, "profile-facts chart-metadata");
		metadata.id = `chart-metadata-${pane}`;
		const warnings = node("ul", undefined, "chart-warnings");
		warnings.id = `chart-warnings-${pane}`;
		const inspect = node("details", undefined, "chart-disclosure");
		const json = node("pre", undefined, "chart-code");
		json.id = `chart-json-${pane}`;
		json.tabIndex = 0;
		json.setAttribute("aria-label", `${pane} chart JSON specification`);
		const python = node("pre", undefined, "chart-code");
		python.id = `chart-python-${pane}`;
		python.tabIndex = 0;
		python.setAttribute("aria-label", `${pane} chart generated Python`);
		inspect.append(
			node("summary", "Inspect JSON and generated Python"),
			node("h4", "Current specification"),
			json,
			node("h4", "Frozen-result Python · inspect only, never executed here"),
			python,
		);
		const exports = node("div", undefined, "button-row chart-exports");
		const exportButtons = (["svg", "png", "html", "json"] as const).map((format) =>
			button(`chart-export-${pane}-${format}`, format.toUpperCase(), () => {
				void download(pane, format);
			}),
		);
		exports.setAttribute("role", "group");
		exports.setAttribute("aria-label", `Export ${pane} chart`);
		exports.append(...exportButtons);
		section.append(heading, error, canvas, metadata, warnings, inspect, exports);
		return { section, heading, error, canvas, metadata, warnings, json, python, exportButtons };
	}
	function clone(spec: ChartSpec): ChartSpec {
		return { ...spec, filters: spec.filters.map((filter) => ({ ...filter })) };
	}
	function key(): string {
		return `datapi.workbench.charts.v1.${encodeURIComponent(context!.projectId)}.${encodeURIComponent(context!.dataset.id)}`;
	}
	function path(): string {
		return `/api/projects/${encodeURIComponent(context!.projectId)}/datasets/${encodeURIComponent(context!.dataset.id)}`;
	}
	function scalarColumns(): DatasetColumn[] {
		return (
			context?.dataset.schema.filter((column) => column.basicType !== "binary" && column.basicType !== "nested") ??
			[]
		);
	}
	function numericColumns(): DatasetColumn[] {
		return scalarColumns().filter((column) => column.basicType === "number" || column.basicType === "text");
	}
	function numericDefault(): number | null {
		return (numericColumns().find((column) => column.basicType === "number") ?? numericColumns()[0])?.index ?? null;
	}
	function matrix(spec: ChartSpec): boolean {
		return ["correlation", "missingness", "model-result"].includes(spec.type);
	}
	function available(spec: ChartSpec, encoding: Encoding): boolean {
		if (matrix(spec)) return false;
		if (encoding === "y")
			return (
				!["histogram"].includes(spec.type) && !(spec.aggregation === "count" && ["bar", "line"].includes(spec.type))
			);
		if (encoding === "color") return spec.type !== "heatmap";
		if (encoding === "size")
			return spec.type === "scatter" || (spec.type === "heatmap" && spec.aggregation !== "count");
		return true;
	}
	function numericEncoding(spec: ChartSpec, encoding: Encoding): boolean {
		return (
			encoding === "size" ||
			(encoding === "x" && ["histogram", "scatter"].includes(spec.type)) ||
			(encoding === "y" && ["box", "bar", "line", "scatter"].includes(spec.type))
		);
	}
	function defaults(type: ChartType): ChartSpec {
		const spec = defaultChartSpec(context!.dataset.currentVersionId);
		spec.type = type;
		const scalar = scalarColumns();
		if (matrix(spec) || type === "scatter" || type === "box") spec.aggregation = "none";
		if (type === "histogram" || type === "scatter") spec.x = numericDefault();
		if (type === "box" || type === "scatter") spec.y = numericDefault();
		if (type === "line" || type === "heatmap") spec.x = scalar[0]?.index ?? null;
		if (type === "heatmap") spec.y = scalar[1]?.index ?? scalar[0]?.index ?? null;
		if (type === "scatter") spec.y = numericColumns().find((column) => column.index !== spec.x)?.index ?? spec.x;
		return spec;
	}
	function validate(): string {
		if (!context || !state) return "Select a dataset first.";
		try {
			parseChartSpec(state[active], context.dataset.schema, context.dataset.currentVersionId);
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : "Choose a valid chart specification.";
		}
	}
	function persist(): void {
		if (!context || !state) return;
		try {
			parseChartSpec(state.left, context.dataset.schema, context.dataset.currentVersionId);
			parseChartSpec(state.right, context.dataset.schema, context.dataset.currentVersionId);
		} catch {
			return;
		}
		try {
			window.localStorage.setItem(key(), JSON.stringify({ ...state, active }));
		} catch {
			storageNote.hidden = false;
			storageNote.textContent =
				"Comparison preferences cannot be saved in this browser. Dataset files and saved chart configurations remain on disk.";
		}
	}
	function restore(): void {
		state = { mode: "single", left: defaults("bar"), right: defaults("bar") };
		active = "left";
		try {
			const saved: unknown = JSON.parse(window.localStorage.getItem(key()) ?? "null");
			if (saved === null) return;
			if (
				typeof saved !== "object" ||
				!("mode" in saved) ||
				!modes.some(([mode]) => mode === saved.mode) ||
				!("left" in saved) ||
				!("right" in saved)
			)
				throw new Error();
			state = {
				mode: saved.mode as ChartComparison["mode"],
				left: parseChartSpec(saved.left, context!.dataset.schema, context!.dataset.currentVersionId),
				right: parseChartSpec(saved.right, context!.dataset.schema, context!.dataset.currentVersionId),
			};
			active =
				"active" in saved && saved.active === "right" && ["chart-chart", "filtered"].includes(state.mode)
					? "right"
					: "left";
			if (state.mode === "filtered") state.right = { ...clone(state.left), filters: state.right.filters };
		} catch {
			storageNote.hidden = false;
			storageNote.textContent =
				"Saved browser comparison is invalid, outdated or unavailable. Safe chart defaults are shown; saved configurations and original data are unchanged.";
		}
	}
	function changed(shared: boolean): void {
		if (!state) return;
		results[active] = null;
		errors[active] = "";
		if (active === "left") selectedRows.clear();
		if (state.mode === "filtered" && shared) {
			const other = active === "left" ? "right" : "left";
			state[other] = { ...clone(state[active]), filters: state[other].filters };
			results[other] = null;
			errors[other] = "";
			selectedRows.clear();
		}
		feedback.textContent = "Specification changed. Render explicitly to compute the bounded result.";
		persist();
		syncControls();
		paint("left");
		paint("right");
		renderTable();
		contextRevision++;
		options.onContextChange?.();
	}
	function renderFields(): void {
		const words = search.value.trim().toLowerCase().split(/\s+/);
		const columns =
			context?.dataset.schema.filter((column) => {
				const profile = context?.profile?.columns.find((item) => item.index === column.index);
				const text =
					`${column.name} ${column.basicType} ${column.sourceType} ${profile?.semanticTypes.map((item) => item.type).join(" ") ?? ""} ${profile?.distinctCount ?? ""} ${profile && profile.distinctCount > 30 ? "high cardinality" : ""}`.toLowerCase();
				return words.every((word) => text.includes(word));
			}) ?? [];
		fieldStatus.textContent = columns.length
			? `${columns.length} fields · distinct counts describe the profiled rows only`
			: "No matching fields. Clear search or try a semantic type.";
		fields.replaceChildren(
			...columns.map((column) => {
				const item = node("li");
				const profile = context?.profile?.columns.find((field) => field.index === column.index);
				const choose = button(`chart-field-${column.index}`, "", () => {
					if (!state) return;
					const encoding = assign.value as Encoding;
					state[active][encoding] = column.index;
					changed(true);
					renderEditor();
				});
				choose.className = "column-option";
				choose.dataset.columnIndex = String(column.index);
				choose.append(
					node("span", column.name),
					node(
						"span",
						`${column.sourceType} · ${profile?.semanticTypes.map((item) => item.type).join(", ") || column.basicType}`,
						"muted",
					),
					node(
						"span",
						profile
							? `${profile.distinctCount} distinct · ${profile.nullCount} null · profiled rows`
							: "Run profile for semantics and cardinality",
						"muted",
					),
				);
				choose.disabled =
					!state ||
					!context?.profile ||
					busy ||
					!available(state[active], assign.value as Encoding) ||
					column.basicType === "nested" ||
					column.basicType === "binary" ||
					(numericEncoding(state[active], assign.value as Encoding) &&
						!["number", "text"].includes(column.basicType));
				item.append(choose);
				return item;
			}),
		);
	}
	function renderRecommendations(): void {
		recommendationList.replaceChildren();
		if (!context?.profile) return;
		for (const [index, recommendation] of recommendCharts(context.profile).entries()) {
			const item = node("li");
			const choose = button(`chart-recommendation-${index}`, names[recommendation.type], () => {
				if (!state || busy) return;
				const spec = defaults(recommendation.type);
				spec.x = recommendation.x;
				spec.y = recommendation.y;
				if ((spec.type === "line" || spec.type === "bar") && spec.y !== null) spec.aggregation = "mean";
				spec.filters = state[active].filters;
				state[active] = spec;
				changed(true);
				renderEditor();
			});
			choose.disabled = busy;
			item.append(choose, node("span", recommendation.reason, "muted"));
			recommendationList.append(item);
		}
	}
	function renderEditor(): void {
		if (!state) return;
		const spec = state[active];
		chartType.value = spec.type;
		mode.value = state.mode;
		paneSelect.value = active;
		for (const encoding of encodings) {
			const columns = numericEncoding(spec, encoding) ? numericColumns() : scalarColumns();
			setOptions(encodingControls[encoding], [
				["", "None"],
				...columns.map((column) => [String(column.index), column.name] as [string, string]),
			]);
			encodingControls[encoding].value = spec[encoding] === null ? "" : String(spec[encoding]);
		}
		const aggregations =
			matrix(spec) || ["scatter", "box"].includes(spec.type)
				? ["none"]
				: spec.type === "histogram"
					? ["count"]
					: spec.type === "heatmap"
						? ["count", "sum", "mean", "median"]
						: ["count", "sum", "mean", "median", "none"];
		setOptions(
			aggregation,
			aggregations.map((value) => [
				value,
				value === "none" ? "None · observed values" : value === "count" ? "Count · observed rows" : value,
			]),
		);
		aggregation.value = spec.aggregation;
		sort.value = spec.sort;
		bins.value = String(spec.bins);
		categoryLimit.value = String(spec.categoryLimit);
		zeroBaseline.checked = spec.zeroBaseline;
		xMin.value = spec.xMin === null ? "" : String(spec.xMin);
		yMin.value = spec.yMin === null ? "" : String(spec.yMin);
		sizeField.querySelector("label")!.textContent =
			spec.type === "heatmap" ? "Cell measure (not marker size)" : "Size (numeric)";
		controlNote.textContent = matrix(spec)
			? "Matrix/model views use their fixed encodings and no aggregation. Correlation uses the first 12 eligible numeric fields; missingness the first 24 fields. Model result is an explicit not-fitted placeholder."
			: spec.type === "heatmap"
				? "Heatmap encodes cell values by color. For numeric aggregation, select Cell measure; count needs no measure. Color grouping is unavailable."
				: spec.type === "histogram"
					? "Histogram counts finite X values in bins. Y, size and sorting are fixed. Invalid numeric values are excluded and reported."
					: spec.type === "box"
						? "Box plots summarize numeric Y; optional X groups observations. No separate aggregation or size encoding."
						: spec.type === "scatter"
							? "Scatter plots observed numeric X and Y with no aggregation, at most 1,000 marks. Size is optional; shapes and labels supplement color."
							: "Count uses observed row counts and clears Y. Numeric aggregations require Y. No dual axes; labels, shapes and facets supplement color.";
		comparisonNote.textContent =
			state.mode === "filtered"
				? "Shared chart encodings; edit each pane’s filters independently. Changing an encoding updates both variants."
				: state.mode === "chart-chart"
					? "Each pane has its own specification. Both render sequentially, never concurrently."
					: state.mode === "data-chart"
						? "Select marks in the left chart to highlight visible original rows."
						: "Changes stay local until you render or save a configuration.";
		renderFilters();
		syncControls();
		renderFields();
		paint("left");
		paint("right");
		renderTable();
	}
	function renderFilters(): void {
		filterList.replaceChildren();
		if (!state) return;
		if (!state[active].filters.length)
			filterList.append(node("p", "No filters. All sampled rows are eligible.", "muted"));
		state[active].filters.forEach((filter, index) => {
			const row = node("div", undefined, "chart-filter");
			const column = select(
				`chart-filter-column-${index}`,
				scalarColumns().map((column) => [String(column.index), column.name]),
			);
			column.value = String(filter.column);
			const op = select(`chart-filter-op-${index}`, operators);
			op.value = filter.op;
			const value = input(`chart-filter-value-${index}`);
			value.value = filter.value;
			value.maxLength = 512;
			value.disabled = ["is-null", "not-null"].includes(filter.op);
			const remove = button(`chart-filter-remove-${index}`, `Remove filter ${index + 1}`, () => {
				state![active].filters.splice(index, 1);
				changed(false);
				renderFilters();
				addFilter.focus();
			});
			column.addEventListener("change", () => {
				filter.column = Number(column.value);
				changed(false);
			});
			op.addEventListener("change", () => {
				filter.op = op.value as ChartFilter["op"];
				if (["is-null", "not-null"].includes(filter.op)) filter.value = "";
				changed(false);
				renderFilters();
				filterList.querySelector<HTMLSelectElement>(`#chart-filter-op-${index}`)?.focus();
			});
			value.addEventListener("input", () => {
				filter.value = value.value;
				changed(false);
			});
			row.append(
				labeled(`Filter ${index + 1} field`, column),
				labeled("Operator", op),
				labeled("Value (literal)", value),
				remove,
			);
			filterList.append(row);
		});
	}
	function syncControls(): void {
		const spec = state?.[active];
		workspace.hidden = !context;
		gate.hidden = Boolean(context?.profile);
		gateText.textContent = !context
			? "Select an imported dataset in the sidebar, then run its profile to create deterministic visualizations."
			: "A current saved profile is required. Use Run profile above the workspace tabs, then return here. Original rows and ingestion statistics stay available.";
		profileButton.hidden = !context;
		const problem = validate();
		validation.textContent = context ? problem : "";
		validation.hidden = !context || !problem;
		renderButton.disabled = !context?.profile || blocked || busy || Boolean(problem);
		renderButton.textContent = busy
			? "Rendering…"
			: state && ["chart-chart", "filtered"].includes(state.mode)
				? "Render both charts"
				: "Render chart";
		cancelButton.hidden = !busy;
		editor.disabled = busy || !context?.profile;
		mode.disabled = busy || !context;
		paneSelect.disabled = busy || !state || !["chart-chart", "filtered"].includes(state.mode);
		if (spec) {
			for (const encoding of encodings) encodingControls[encoding].disabled = !available(spec, encoding);
			aggregation.disabled = matrix(spec) || ["histogram", "box", "scatter"].includes(spec.type);
			sort.disabled = !["bar", "box", "line"].includes(spec.type);
			bins.disabled = spec.type !== "histogram";
			categoryLimit.disabled = matrix(spec);
			zeroBaseline.disabled = matrix(spec) || spec.type === "heatmap";
			xMin.disabled = matrix(spec) || ["heatmap", "bar", "box"].includes(spec.type);
			yMin.disabled = matrix(spec) || spec.type === "heatmap";
			addFilter.disabled = spec.filters.length >= 8 || scalarColumns().length === 0;
			const warnings: string[] = [];
			for (const encoding of ["x", "color", "facet"] as const) {
				const profile = context?.profile?.columns.find((column) => column.index === spec[encoding]);
				const limit = encoding === "color" ? 10 : encoding === "facet" ? 4 : spec.categoryLimit;
				if (
					profile &&
					profile.distinctCount > limit &&
					(encoding !== "x" || ["bar", "box", "line", "heatmap"].includes(spec.type))
				)
					warnings.push(
						`${encoding.toUpperCase()}: ${profile.distinctCount} profiled distinct values exceeds display limit ${limit}; some categories can be omitted.`,
					);
			}
			if (!spec.zeroBaseline || spec.xMin !== null || spec.yMin !== null)
				warnings.push(
					"Custom axis bounds can hide variation or exaggerate differences. Review axis warnings after rendering.",
				);
			safeguards.textContent = warnings.join(" ");
			safeguards.hidden = warnings.length === 0;
		}
		const record = records.find((record) => record.id === selectedId);
		savedSelect.disabled = saving || records.length === 0;
		chartName.disabled = saving;
		loadButton.disabled = busy || saving || !record;
		saveNew.disabled = saving || !context || Boolean(problem);
		updateSaved.disabled = saving || !record || Boolean(problem);
		duplicate.disabled = saving || !record;
		rename.disabled = saving || !record;
		deleteButton.disabled = saving || !record;
		confirmDelete.disabled = saving;
		dismissDelete.disabled = saving;
		refresh.disabled = saving || Boolean(listAbort);
		canvases.dataset.mode = state?.mode ?? "single";
		tablePanel.hidden = state?.mode !== "data-chart";
		paneElements.right.section.hidden = !state || !["chart-chart", "filtered"].includes(state.mode);
		for (const pane of ["left", "right"] as const) {
			paneElements[pane].section.dataset.active = String(active === pane);
			for (const action of paneElements[pane].exportButtons)
				action.disabled = !results[pane] || exportBusy[pane] || busy;
		}
	}
	function paint(pane: Pane): void {
		const ui = paneElements[pane];
		const result = results[pane];
		ui.heading.textContent = `${pane === "left" ? "Left" : "Right"} · ${state ? names[state[pane].type] : "Chart"}`;
		ui.error.textContent = errors[pane];
		ui.error.hidden = !errors[pane];
		ui.json.textContent = state ? JSON.stringify(state[pane], null, 2) : "Select a dataset.";
		if (result && painted[pane] === result) return;
		painted[pane] = result;
		ui.metadata.replaceChildren();
		ui.warnings.replaceChildren();
		if (!result) {
			ui.canvas.replaceChildren(
				node(
					"p",
					busy
						? "Waiting for this bounded chart result…"
						: "Choose fields or a recommendation, then Render chart. No automatic queries.",
					"chart-canvas-empty",
				),
			);
			ui.python.textContent = "Render this specification to inspect Python reproducing its frozen bounded result.";
			return;
		}
		renderChart(
			ui.canvas,
			result,
			pane === "left"
				? (ids) => {
						selectedRows = new Set(ids);
						renderTable();
					}
				: undefined,
		);
		const facts: [string, string][] = [
			[
				"Sample",
				`${result.sampleSize} / ${result.populationRows} rows · ${result.sampled ? "sampled, not population estimates" : "all rows"} · stride ${result.stride} · byte cap ${result.byteLimited ? "reached" : "not reached"}`,
			],
			["Filters", `${result.labels.filters} · ${result.filteredRows} rows remain`],
			["Aggregation", result.labels.aggregation],
			["Missing / invalid values", `${result.labels.missing} · ${result.excludedRows} excluded rows`],
			["Display", `${result.marks.length} marks · ${result.omittedMarks} omitted marks`],
			[
				"Encodings",
				`X: ${result.labels.x}; Y: ${result.labels.y}; color: ${result.labels.color}; size: ${result.labels.size}; facet: ${result.labels.facet}`,
			],
			["Provenance", `${result.spec.datasetVersionId} · ${result.datasetVersionHash} · ${result.generatedAt}`],
		];
		for (const [label, value] of facts) ui.metadata.append(node("dt", label), node("dd", value));
		ui.warnings.append(...result.warnings.map((warning) => node("li", warning)));
		ui.python.textContent = generateChartPython(result);
	}
	function renderTable(): void {
		const result = results.left;
		const rows = result?.table.rows ?? [];
		const visible = rows.filter((row) => selectedRows.has(row.rowId)).length;
		selectionStatus.textContent = selectedRows.size
			? `${selectedRows.size} selected source rows; ${visible} of ${rows.length} visible rows highlighted. ${selectedRows.size - visible} selected rows are outside this bounded table.`
			: `${rows.length} visible rows · no selection. NULL = missing; ∅ = empty string.`;
		clearSelection.disabled = selectedRows.size === 0;
		if (!result) {
			tableScroll.replaceChildren(
				node("p", "Render a chart to inspect its filtered sample rows.", "table-footnote"),
			);
			return;
		}
		const table = node("table");
		const head = node("thead");
		const heading = node("tr");
		const first = node("th", "Source row");
		first.scope = "col";
		heading.append(first);
		for (const column of result.table.columns) {
			const cell = node("th", column.name);
			cell.scope = "col";
			heading.append(cell);
		}
		head.append(heading);
		const body = node("tbody");
		for (const row of rows) {
			const tr = node("tr");
			tr.dataset.rowId = String(row.rowId);
			tr.dataset.highlighted = String(selectedRows.has(row.rowId));
			const number = node("th", String(row.rowId + 1), "row-number");
			number.scope = "row";
			if (selectedRows.has(row.rowId)) number.append(node("span", " · selected", "visually-hidden"));
			tr.append(number);
			for (const value of row.values) {
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
					if (value.length > 32 || /[\r\n]/.test(value)) {
						content.tabIndex = 0;
						content.setAttribute("role", "region");
						content.setAttribute("aria-label", "Scrollable original cell value");
					}
					cell.append(content);
				}
				tr.append(cell);
			}
			body.append(tr);
		}
		table.append(
			node("caption", "Bounded filtered sample, original values and source row numbers", "visually-hidden"),
			head,
			body,
		);
		tableScroll.replaceChildren(table);
	}
	function setBusy(value: boolean): void {
		if (busy === value) return;
		busy = value;
		syncControls();
		options.onBusy?.(value);
		renderRecommendations();
		renderFields();
	}
	function cancelRender(): void {
		renderSequence++;
		renderAbort?.abort();
		renderAbort = null;
		if (busy) {
			setBusy(false);
			feedback.textContent =
				"Render cancelled. Completed pane results remain available; uncompleted panes have no result.";
			for (const pane of ["left", "right"] as const) if (!results[pane]) paint(pane);
		}
	}
	async function run(): Promise<void> {
		if (!context?.profile || !state || busy || blocked) return;
		const panes: Pane[] = ["chart-chart", "filtered"].includes(state.mode) ? ["left", "right"] : ["left"];
		const snapshot = {} as Record<Pane, ChartSpec>;
		try {
			for (const pane of panes)
				snapshot[pane] = parseChartSpec(state[pane], context.dataset.schema, context.dataset.currentVersionId);
		} catch (error) {
			feedback.textContent = error instanceof Error ? error.message : "Check chart fields before rendering.";
			return;
		}
		const owner = generation;
		const request = ++renderSequence;
		const endpoint = `${path()}/chart-preview`;
		const controller = new window.AbortController();
		renderAbort = controller;
		selectedRows.clear();
		for (const pane of panes) {
			results[pane] = null;
			errors[pane] = "";
		}
		setBusy(true);
		for (const pane of panes) paint(pane);
		renderTable();
		let completed = 0;
		for (const pane of panes) {
			if (owner !== generation || request !== renderSequence || controller.signal.aborted) return;
			feedback.textContent = `Rendering ${pane} chart (${panes.indexOf(pane) + 1} of ${panes.length})…`;
			try {
				const result = await options.api<ChartResult>(endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ spec: snapshot[pane] }),
					signal: controller.signal,
				});
				if (owner !== generation || request !== renderSequence || controller.signal.aborted) return;
				if (
					!Object.entries(snapshot[pane]).every(
						([key, value]) => JSON.stringify(result.spec[key as keyof ChartSpec]) === JSON.stringify(value),
					)
				)
					throw new Error("The chart response does not match the requested specification.");
				results[pane] = result;
				completed++;
				paint(pane);
				if (pane === "left") renderTable();
			} catch (error) {
				if (owner !== generation || request !== renderSequence || controller.signal.aborted) return;
				errors[pane] =
					options.message?.(error) ??
					(error instanceof Error ? error.message : "Could not render this chart. Try again.");
				paint(pane);
			}
		}
		if (owner !== generation || request !== renderSequence) return;
		renderAbort = null;
		setBusy(false);
		feedback.textContent =
			completed === panes.length
				? `${completed} chart${completed === 1 ? "" : "s"} rendered. Results describe only the bounded sample; original data is unchanged.`
				: `${completed} of ${panes.length} charts rendered. Review each pane’s error; successful results remain available.`;
	}
	async function loadList(): Promise<void> {
		if (!context || listed || listAbort || disposed || panel.hidden) return;
		const owner = generation;
		const endpoint = `${path()}/charts`;
		const controller = new window.AbortController();
		listAbort = controller;
		savedStatus.textContent = "Loading saved chart configurations…";
		savedError.textContent = "";
		syncControls();
		try {
			const loaded = await options.api<ChartRecord[]>(endpoint, { signal: controller.signal });
			if (owner !== generation || controller.signal.aborted) return;
			records = loaded;
			listed = true;
			renderSaved();
		} catch (error) {
			if (owner !== generation || controller.signal.aborted) return;
			savedStatus.textContent = "Saved charts unavailable.";
			savedError.textContent = options.message?.(error) ?? "Could not load saved charts. Use Reload saved charts.";
		} finally {
			if (owner === generation) {
				listAbort = null;
				syncControls();
			}
		}
	}
	function renderSaved(): void {
		setOptions(savedSelect, [
			["", "Choose a saved chart"],
			...records.map(
				(record) =>
					[
						record.id,
						`${record.name}${record.spec.datasetVersionId !== context?.dataset.currentVersionId ? " · earlier version" : ""}`,
					] as [string, string],
			),
		]);
		if (!records.some((record) => record.id === selectedId)) selectedId = "";
		savedSelect.value = selectedId;
		savedStatus.textContent = records.length
			? `${records.length} saved configurations · saving never modifies source data`
			: "No saved charts yet. Name this specification and choose Save new.";
		syncControls();
	}
	function loadSaved(): void {
		const record = records.find((record) => record.id === selectedId);
		if (!record || !state || !context || busy) return;
		try {
			state[active] = parseChartSpec(record.spec, context.dataset.schema, context.dataset.currentVersionId);
			changed(true);
			renderEditor();
			savedError.textContent = "";
		} catch {
			savedError.textContent =
				"This saved chart does not match the current dataset version or schema. It has not been retargeted. You can rename, duplicate or delete its configuration, or create a new chart for this version.";
		}
	}
	async function mutate(action: "new" | "update" | "duplicate" | "rename" | "delete"): Promise<void> {
		if (!context || !state || saving) return;
		const record = records.find((record) => record.id === selectedId);
		if (action !== "new" && !record) return;
		if (action === "delete" && deleteConfirmation.hidden) return;
		let spec = record?.spec ?? state[active];
		const name = action === "duplicate" ? `${record!.name.slice(0, 113)} (copy)` : chartName.value.trim();
		if (action !== "delete" && !name) {
			savedError.textContent = "Enter a configuration name first.";
			chartName.focus();
			return;
		}
		if (action === "new" || action === "update") {
			try {
				spec = parseChartSpec(state[active], context.dataset.schema, context.dataset.currentVersionId);
			} catch {
				savedError.textContent = "Correct the active chart specification before saving.";
				return;
			}
		}
		const owner = generation;
		const endpoint = `${path()}/charts${action === "new" || action === "duplicate" ? "" : `/${encodeURIComponent(record!.id)}`}`;
		const controller = new window.AbortController();
		saveAbort = controller;
		saving = true;
		savedError.textContent = "";
		syncControls();
		try {
			const result = await options.api<ChartRecord | { deleted: true }>(endpoint, {
				method: action === "delete" ? "DELETE" : action === "new" || action === "duplicate" ? "POST" : "PUT",
				headers: { "Content-Type": "application/json" },
				...(action === "delete" ? {} : { body: JSON.stringify({ name, spec }) }),
				signal: controller.signal,
			});
			if (owner !== generation || controller.signal.aborted) return;
			if (action === "delete") {
				records = records.filter((item) => item.id !== record!.id);
				selectedId = "";
				chartName.value = "";
			} else if ("spec" in result) {
				records = records.filter((item) => item.id !== result.id);
				records.unshift(result);
				selectedId = result.id;
				chartName.value = result.name;
			}
			deleteConfirmation.hidden = true;
			renderSaved();
			savedStatus.textContent =
				action === "delete"
					? "Configuration deleted. Original data is unchanged."
					: "Configuration saved locally. Original data is unchanged.";
		} catch (error) {
			if (owner === generation && !controller.signal.aborted)
				savedError.textContent =
					options.message?.(error) ??
					"Could not save this change. Reload saved charts to check the server state before retrying.";
		} finally {
			if (owner === generation) {
				saving = false;
				saveAbort = null;
				syncControls();
			}
		}
	}
	async function download(pane: Pane, format: "svg" | "png" | "html" | "json"): Promise<void> {
		const result = results[pane];
		if (!result || exportBusy[pane]) return;
		const owner = generation;
		exportBusy[pane] = true;
		syncControls();
		try {
			const file = await exportChart(result, format);
			if (owner !== generation || result !== results[pane]) return;
			const url = window.URL.createObjectURL(file.blob);
			const anchor = node("a");
			anchor.href = url;
			anchor.download = `chart-${pane}-${result.spec.type}.${file.extension}`;
			try {
				document.body.append(anchor);
				anchor.click();
			} finally {
				anchor.remove();
				window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
			}
			feedback.textContent = `${format.toUpperCase()} export prepared for the ${pane} chart’s frozen result.`;
		} catch (error) {
			if (owner === generation) {
				errors[pane] = error instanceof Error ? error.message : "Export failed. Try another format.";
				paint(pane);
			}
		} finally {
			if (owner === generation) {
				exportBusy[pane] = false;
				syncControls();
			}
		}
	}

	search.addEventListener("input", renderFields);
	search.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			search.value = "";
			renderFields();
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			fields.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		}
	});
	assign.addEventListener("change", renderFields);
	fields.addEventListener("keydown", (event) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const buttons = [...fields.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (index < 0) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
		buttons[next]?.focus();
	});
	chartType.addEventListener("change", () => {
		if (!state) return;
		const next = defaults(chartType.value as ChartType);
		next.filters = state[active].filters;
		state[active] = next;
		changed(true);
		renderEditor();
		feedback.textContent =
			"Chart type changed. Unsupported encodings, aggregation and axis options were reset to explicit safe defaults; filters were preserved.";
	});
	for (const encoding of encodings)
		encodingControls[encoding].addEventListener("change", () => {
			if (!state) return;
			state[active][encoding] =
				encodingControls[encoding].value === "" ? null : Number(encodingControls[encoding].value);
			changed(true);
		});
	aggregation.addEventListener("change", () => {
		if (!state) return;
		const spec = state[active];
		spec.aggregation = aggregation.value as ChartSpec["aggregation"];
		if (spec.type === "heatmap") spec.size = spec.aggregation === "count" ? null : (spec.size ?? numericDefault());
		else spec.y = spec.aggregation === "count" ? null : (spec.y ?? numericDefault());
		changed(true);
		renderEditor();
	});
	sort.addEventListener("change", () => {
		if (state) {
			state[active].sort = sort.value as ChartSpec["sort"];
			changed(true);
		}
	});
	for (const [control, field] of [
		[bins, "bins"],
		[categoryLimit, "categoryLimit"],
		[xMin, "xMin"],
		[yMin, "yMin"],
	] as const)
		control.addEventListener("input", () => {
			if (!state) return;
			const nullable = field === "xMin" || field === "yMin";
			state[active] = { ...state[active], [field]: nullable && control.value === "" ? null : Number(control.value) };
			changed(true);
		});
	zeroBaseline.addEventListener("change", () => {
		if (state) {
			state[active].zeroBaseline = zeroBaseline.checked;
			changed(true);
		}
	});
	mode.addEventListener("change", () => {
		if (!state) return;
		state.mode = mode.value as ChartComparison["mode"];
		if (!["chart-chart", "filtered"].includes(state.mode)) active = "left";
		if (state.mode === "filtered") {
			state.right = { ...clone(state.left), filters: state.right.filters };
			results.right = null;
			errors.right = "";
		}
		persist();
		renderEditor();
		contextRevision++;
		options.onContextChange?.();
	});
	paneSelect.addEventListener("change", () => {
		active = paneSelect.value as Pane;
		persist();
		renderEditor();
		contextRevision++;
		options.onContextChange?.();
	});
	savedSelect.addEventListener("change", () => {
		selectedId = savedSelect.value;
		chartName.value = records.find((record) => record.id === selectedId)?.name ?? "";
		deleteConfirmation.hidden = true;
		savedError.textContent = "";
		syncControls();
	});
	function clear(): void {
		generation++;
		cancelRender();
		listAbort?.abort();
		saveAbort?.abort();
		listAbort = null;
		saveAbort = null;
		context = null;
		state = null;
		records = [];
		listed = false;
		selectedId = "";
		saving = false;
		active = "left";
		results.left = null;
		results.right = null;
		errors.left = "";
		errors.right = "";
		exportBusy.left = false;
		exportBusy.right = false;
		selectedRows.clear();
		painted.left = null;
		painted.right = null;
		chartName.value = "";
		search.value = "";
		feedback.textContent = "";
		savedError.textContent = "";
		storageNote.hidden = true;
		deleteConfirmation.hidden = true;
		datasetName.textContent = "Visualization studio";
		syncControls();
		paint("left");
		paint("right");
		renderTable();
	}
	clear();
	return {
		update(next) {
			if (disposed) return;
			const same =
				context?.projectId === next.projectId &&
				context.dataset.id === next.dataset.id &&
				context.dataset.currentVersionId === next.dataset.currentVersionId;
			if (!same) {
				clear();
				context = next;
				restore();
			} else context = next;
			if (context.profile?.datasetVersionId !== context.dataset.currentVersionId)
				context = { ...context, profile: null };
			datasetName.textContent = next.dataset.name;
			renderEditor();
			renderRecommendations();
			void loadList();
		},
		clear,
		getSelection() {
			if (!state || !context) return { selectedColumns: [], filters: [], revision: contextRevision };
			const spec = state[active];
			const columns =
				spec.type === "missingness"
					? context.dataset.schema.slice(0, 24).map((column) => column.index)
					: spec.type === "correlation"
						? context.dataset.schema
								.filter((column) => column.basicType === "number")
								.slice(0, 12)
								.map((column) => column.index)
						: encodings.flatMap((encoding) => (spec[encoding] === null ? [] : [spec[encoding]!]));
			return {
				selectedColumns: [...new Set([...columns, ...spec.filters.map((filter) => filter.column)])],
				filters: spec.filters.map((filter) => ({ ...filter })),
				revision: contextRevision,
			};
		},
		applySpec(spec) {
			if (!context || !state || disposed || busy || blocked)
				throw new Error("Wait for the current operation before opening this chart.");
			const parsed = parseChartSpec(spec, context.dataset.schema, context.dataset.currentVersionId);
			skipNextVisibleList = panel.hidden;
			active = "left";
			state.mode = "single";
			state.left = parsed;
			changed(false);
			renderEditor();
			feedback.textContent =
				"Applied suggestion opened. Render explicitly to compute its bounded result; no query was run.";
		},
		setBlocked(value) {
			if (blocked === value) return;
			blocked = value;
			syncControls();
		},
		dispose() {
			disposed = true;
			visibility.disconnect();
			theme.disconnect();
			clear();
			container.replaceChildren();
		},
	};
}
