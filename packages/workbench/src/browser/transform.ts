import type { Dataset } from "../contracts.ts";
import type {
	TransformHistory,
	TransformImpact,
	TransformOperation,
	TransformPreview,
	TransformSpec,
} from "../transform-contracts.ts";
import { parseTransformSpec } from "../transform-spec.ts";

interface TransformContext {
	projectId: string;
	dataset: Dataset;
}
interface TransformOptions {
	api<T>(path: string, options?: RequestInit): Promise<T>;
	message(error: unknown): string;
	onBusy?(busy: boolean): void;
	onChanged(dataset: Dataset): Promise<void> | void;
}
export interface TransformController {
	update(context: TransformContext): void;
	clear(): void;
	setBlocked(blocked: boolean): void;
	acceptProposal(spec: TransformSpec): void;
	dispose(): void;
}
const operationNames: Record<TransformOperation["kind"], string> = {
	rename: "Rename column",
	cast: "Cast column",
	drop: "Drop columns",
	filter: "Filter rows",
	missing: "Handle missing values",
	deduplicate: "Deduplicate rows",
	map: "Map categories",
	datetime: "Extract datetime component",
	scale: "Scale field",
	encode: "Encode categories",
	derive: "Derive column",
};
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export function initializeTransform(container: HTMLElement, options: TransformOptions): TransformController {
	const document = container.ownerDocument;
	const window = document.defaultView!;
	let context: TransformContext | null = null;
	let blocked = false;
	let disposed = false;
	let busy: "preview" | "apply" | "undo" | "redo" | null = null;
	let generation = 0;
	let historyGeneration = 0;
	let requestAbort: AbortController | null = null;
	let historyAbort: AbortController | null = null;
	let preview: TransformPreview | null = null;
	let previewSpec = "";
	let history: TransformHistory | null = null;
	let expiryTimer: number | undefined;
	let fields: Record<string, Control> = {};

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
	function button(id: string, text: string, action: () => void): HTMLButtonElement {
		const result = node("button", text, "button");
		result.id = id;
		result.type = "button";
		result.addEventListener("click", action);
		return result;
	}
	function label(text: string, control: Control): HTMLDivElement {
		const wrapper = node("div", undefined, "chart-control");
		const caption = node("label", text);
		caption.htmlFor = control.id;
		wrapper.append(caption, control);
		return wrapper;
	}
	function setOptions(select: HTMLSelectElement, values: readonly (readonly [string, string])[]): void {
		select.replaceChildren(
			...values.map(([value, text]) => {
				const option = node("option", text);
				option.value = value;
				return option;
			}),
		);
	}
	const heading = node("h2", "Transform dataset");
	heading.tabIndex = -1;
	const description = node(
		"p",
		"Full-dataset, reproducible operations. Preview stages a new immutable version; nothing is applied until you approve. Original uploads are never changed.",
		"table-footnote",
	);
	const active = node("p", "Select a dataset to transform.", "profile-basis");
	active.id = "transform-context";
	const status = node("p", undefined, "table-footnote");
	status.id = "transform-status";
	status.setAttribute("role", "status");
	const error = node("p", undefined, "inline-error");
	error.id = "transform-error";
	error.setAttribute("role", "alert");
	const form = node("form");
	form.id = "transform-form";
	const editor = node("fieldset", undefined, "chart-editor transform-editor");
	editor.append(node("legend", "Operation and parameters"));
	const kind = node("select");
	kind.id = "transform-kind";
	setOptions(kind, Object.entries(operationNames));
	const parameters = node("div", undefined, "transform-fields");
	const help = node("p", undefined, "table-footnote");
	help.id = "transform-help";
	editor.append(label("Operation", kind), parameters, help);
	const previewButton = node("button", "Preview full-dataset impact", "button button-primary");
	previewButton.id = "transform-preview";
	previewButton.type = "submit";
	const cancelButton = button("transform-cancel", "Cancel / discard preview", () => {
		invalidate();
		status.textContent = "Preview cancelled. No version was applied.";
		void loadHistory();
		previewButton.focus();
	});
	const actions = node("div", undefined, "button-row");
	actions.append(previewButton, cancelButton);
	form.append(editor, actions);
	const review = node("section", undefined, "transform-review");
	review.id = "transform-review";
	review.setAttribute("aria-label", "Transformation impact and approval");
	const impactPanel = node("div", undefined, "transform-impact");
	const approval = node("input");
	approval.type = "checkbox";
	approval.id = "transform-approval";
	const approvalLabel = node("label", undefined, "assistant-check");
	approvalLabel.htmlFor = approval.id;
	approvalLabel.append(
		approval,
		node("span", "I reviewed this exact preview and approve creating its new dataset version."),
	);
	const applyButton = button("transform-apply", "Apply approved transformation", () => {
		void mutate("apply");
	});
	applyButton.classList.add("button-primary");
	review.append(impactPanel, approvalLabel, applyButton);
	const historySection = node("section", undefined, "transform-history");
	historySection.setAttribute("aria-label", "Transformation history");
	const historyActions = node("div", undefined, "button-row");
	const undoButton = button("transform-undo", "Undo", () => {
		void mutate("undo");
	});
	const redoButton = button("transform-redo", "Redo", () => {
		void mutate("redo");
	});
	const historyButton = button("transform-history-refresh", "Refresh history", () => {
		void loadHistory();
	});
	const reloadButton = button("transform-reload", "Reload active dataset", () => {
		if (context && !busy) void options.onChanged(context.dataset);
	});
	historyActions.append(undoButton, redoButton, historyButton, reloadButton);
	const historyStatus = node("p", undefined, "table-footnote");
	historyStatus.id = "transform-history-status";
	historyStatus.setAttribute("role", "status");
	const historyList = node("div");
	historyList.id = "transform-history";
	historySection.append(
		node("h3", "Version history"),
		node(
			"p",
			"Undo and redo change the active version, not its files. A new apply clears the redo path; prior versions remain recorded.",
			"table-footnote",
		),
		historyActions,
		historyStatus,
		historyList,
	);
	container.classList.add("transform-workspace");
	container.replaceChildren(heading, description, active, form, status, error, review, historySection);
	const visibility = new window.MutationObserver(() => {
		if (!container.hidden && context && !busy) void loadHistory();
	});
	visibility.observe(container, { attributes: true, attributeFilter: ["hidden"] });

	function route(owner: TransformContext): string {
		return `/api/projects/${encodeURIComponent(owner.projectId)}/datasets/${encodeURIComponent(owner.dataset.id)}/transforms`;
	}
	function same(owner: TransformContext): boolean {
		return (
			!disposed &&
			context?.projectId === owner.projectId &&
			context.dataset.id === owner.dataset.id &&
			context.dataset.currentVersionId === owner.dataset.currentVersionId
		);
	}
	function setBusy(value: typeof busy): void {
		const changed = Boolean(busy) !== Boolean(value);
		busy = value;
		sync();
		if (changed) options.onBusy?.(Boolean(value));
	}
	function sync(): void {
		editor.disabled = !context || blocked || busy === "apply" || busy === "undo" || busy === "redo";
		previewButton.disabled = !context || blocked || Boolean(busy);
		cancelButton.disabled = busy === "apply" || busy === "undo" || busy === "redo" || (!busy && !preview);
		cancelButton.hidden = !busy && !preview;
		review.hidden = !preview;
		approval.disabled = !preview || blocked || Boolean(busy);
		applyButton.disabled = !preview || !approval.checked || blocked || Boolean(busy);
		undoButton.disabled = !context || !history?.canUndo || blocked || Boolean(busy);
		redoButton.disabled = !context || !history?.canRedo || blocked || Boolean(busy);
		historyButton.disabled = !context || Boolean(busy);
		reloadButton.disabled = !context || Boolean(busy);
		container.setAttribute("aria-busy", String(Boolean(busy)));
	}
	async function discard(value: TransformPreview, owner: TransformContext): Promise<void> {
		try {
			await options.api(`${route(owner)}/previews/${encodeURIComponent(value.id)}`, { method: "DELETE" });
		} catch (reason) {
			if (same(owner))
				error.textContent = `${options.message(reason)} Preview discard was not confirmed; approval is cleared. The server preview expires automatically.`;
		}
	}
	function invalidate(): void {
		generation++;
		requestAbort?.abort();
		requestAbort = null;
		if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
		expiryTimer = undefined;
		if (preview && context) void discard(preview, context);
		preview = null;
		previewSpec = "";
		approval.checked = false;
		impactPanel.replaceChildren();
		error.textContent = "";
		setBusy(null);
	}
	function addSelect(
		key: string,
		text: string,
		values: readonly string[] | readonly (readonly [string, string])[],
	): HTMLSelectElement {
		const control = node("select");
		control.id = `transform-${key}`;
		setOptions(
			control,
			values.map((value): readonly [string, string] => (typeof value === "string" ? [value, value] : value)),
		);
		fields[key] = control;
		parameters.append(label(text, control));
		return control;
	}
	function addText(key: string, text: string, value = "", multiline = false): Control {
		const control = multiline ? node("textarea") : node("input");
		control.id = `transform-${key}`;
		control.value = value;
		control.spellcheck = false;
		if (multiline) {
			control.setAttribute("rows", "6");
			control.classList.add("transform-json");
		}
		fields[key] = control;
		parameters.append(label(text, control));
		return control;
	}
	function buildFields(operation?: TransformOperation): void {
		parameters.replaceChildren();
		fields = {};
		const selected = kind.value;
		const columns =
			context?.dataset.schema.map(
				(column) =>
					[String(column.index), `${column.name} · ${column.sourceType} · index ${column.index}`] as const,
			) ?? [];
		if (!["drop", "missing", "deduplicate", "derive"].includes(selected)) addSelect("column", "Input field", columns);
		if (["drop", "missing", "deduplicate"].includes(selected)) {
			const multiple = addSelect("columns", "Input fields (Ctrl/Cmd or Shift to select multiple)", columns);
			multiple.multiple = true;
			multiple.size = Math.min(8, Math.max(2, columns.length));
			if (multiple.options[0]) multiple.options[0].selected = true;
		}
		if (["rename", "datetime", "scale", "encode", "derive"].includes(selected))
			addText(
				"name",
				selected === "rename" ? "New column name" : "Output name / encoding prefix",
				selected === "rename" ? "renamed" : "derived",
			);
		help.textContent =
			"Field indexes refer to the current input schema. Every preview scans the full dataset; only the displayed samples are bounded.";
		switch (selected) {
			case "cast":
				addSelect("type", "Target type", ["text", "number", "integer", "boolean", "date", "timestamp"]);
				addSelect("invalid", "Invalid values", [
					["error", "Fail without changing data"],
					["null", "Replace invalid values with NULL"],
				]);
				help.textContent =
					"Number uses approximate DOUBLE; integer requires strict BIGINT. Dates and timestamps use ISO values in UTC. Review invalid-value handling explicitly.";
				break;
			case "filter":
				addSelect("operator", "Keep rows where", [
					["eq", "Equals"],
					["ne", "Not equal"],
					["lt", "Less than"],
					["lte", "At most"],
					["gt", "Greater than"],
					["gte", "At least"],
					["contains", "Contains"],
					["is-null", "Is NULL"],
					["not-null", "Is not NULL"],
				]);
				addSelect("comparison", "Comparison type", ["text", "number"]);
				addText("value", "Comparison value (literal text, never code)");
				help.textContent =
					"Only matching rows are kept. NULL predicates do not use a comparison value. Numeric comparisons require finite decimal text.";
				break;
			case "missing":
				addSelect("method", "Missing-value method", [
					["constant", "Fill with constant"],
					["mean", "Fill with full-dataset mean"],
					["median", "Fill with full-dataset median"],
					["drop", "Drop rows with selected missing values"],
				]);
				addSelect("missing", "Treat as missing", [
					["null", "NULL only"],
					["empty", "Empty strings only"],
					["both", "NULL and empty strings"],
				]);
				addSelect("value-type", "Constant replacement type", [
					["text", "Literal text"],
					["null", "NULL"],
				]);
				addText("value", "Constant text (empty string is allowed)");
				help.textContent =
					"Mean and median are numeric, full-dataset floating-point calculations, not sample estimates. NULL and empty strings are distinct; whitespace is not empty.";
				break;
			case "map":
				addText(
					"entries",
					"Category mapping JSON (from → to; null is allowed)",
					'[{"from":"old","to":"new"},{"from":"missing","to":null}]',
					true,
				);
				addSelect("unmatched", "Unmatched categories", [
					["keep", "Keep original"],
					["null", "Replace with NULL"],
				]);
				help.textContent =
					'Enter an array of exact text mappings, e.g. [{"from":"NY","to":"New York"}]. No scripts or regular expressions are executed.';
				break;
			case "datetime":
				addSelect("component", "Datetime component (UTC)", ["year", "month", "day", "weekday", "hour"]);
				help.textContent =
					"ISO dates and timestamps are interpreted in UTC. A new column is appended; the input field is preserved.";
				break;
			case "scale":
				addSelect("method", "Scaling method", [
					["standard", "Standard score"],
					["minmax", "Min–max (0 to 1)"],
				]);
				help.textContent =
					"Uses full-dataset numeric statistics and approximate DOUBLE arithmetic. A new column is appended; review warnings for constant or invalid fields.";
				break;
			case "encode":
				addSelect("method", "Encoding method", [
					["ordinal", "Ordinal"],
					["one-hot", "One-hot"],
				]);
				addText("categories", "Ordered categories JSON ([] discovers sorted categories)", "[]", true);
				help.textContent =
					'Use an ordered text array, e.g. ["low","medium","high"]. [] discovers sorted non-null categories (maximum 128). One-hot columns are prefix_0, prefix_1, …; unknowns are all 0 and NULLs all NULL. Ordinal unknowns are NULL. Explicit category order is retained.';
				break;
			case "derive":
				addText(
					"expression",
					"Restricted expression AST (JSON, not source code)",
					JSON.stringify(
						{
							kind: "binary",
							operator: "multiply",
							left: { kind: "column", column: context?.dataset.schema[0]?.index ?? 0 },
							right: { kind: "literal", value: 2 },
						},
						null,
						2,
					),
					true,
				);
				parameters.append(
					table(
						"Input field indexes for expression trees",
						["Index", "Name", "Basic type", "Native type"],
						(context?.dataset.schema ?? []).map((column) => [
							String(column.index),
							column.name,
							column.basicType,
							column.sourceType,
						]),
					),
				);
				help.textContent =
					'Only structured trees are accepted: column {"kind":"column","column":0}, literal {"kind":"literal","value":2}, binary operators add/subtract/multiply/divide with left/right trees, or {"kind":"call","function":"abs","args":[...]} (also round, lower, upper, trim, length, coalesce). The example multiplies input column 0 by 2. No arbitrary Python, JavaScript, SQL, file or network access.';
				break;
			case "deduplicate":
				help.textContent =
					"Keep the first row in deterministic input order for each combination of selected fields.";
				break;
			case "drop":
				help.textContent =
					"Remove selected columns. At least one column must remain. The original uploaded dataset is preserved.";
				break;
		}
		if (operation)
			for (const [key, value] of Object.entries(operation)) {
				const control = fields[key];
				if (!control) continue;
				if (key === "columns" && control.tagName === "SELECT" && Array.isArray(value)) {
					for (const option of (control as HTMLSelectElement).options)
						option.selected = value.includes(Number(option.value));
				} else
					control.value =
						value === null ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
			}
		if (operation?.kind === "missing") fields["value-type"].value = operation.value === null ? "null" : "text";
		syncVariants();
	}
	function syncVariants(): void {
		if (kind.value === "filter") {
			const noValue = fields.operator.value === "is-null" || fields.operator.value === "not-null";
			fields.value.disabled = noValue;
			fields.comparison.disabled = noValue;
		}
		if (kind.value === "missing") {
			fields["value-type"].disabled = fields.method.value !== "constant";
			fields.value.disabled = fields.method.value !== "constant" || fields["value-type"].value === "null";
		}
	}
	function readSpec(): TransformSpec {
		if (!context) throw new Error("Select a dataset first.");
		const operation: Record<string, unknown> = { kind: kind.value };
		for (const [key, control] of Object.entries(fields)) {
			if (key === "value-type") continue;
			if (key === "column") operation[key] = Number(control.value);
			else if (key === "columns")
				operation[key] = [...(control as HTMLSelectElement).selectedOptions].map((option) => Number(option.value));
			else if (["expression", "entries", "categories"].includes(key)) {
				try {
					operation[key] = JSON.parse(control.value);
				} catch {
					throw new Error(`${key} must be valid JSON. Use the example shown for this operation.`);
				}
			} else operation[key] = control.value;
		}
		if (kind.value === "filter" && ["is-null", "not-null"].includes(String(operation.operator))) {
			operation.value = null;
			operation.comparison = "text";
		}
		if (kind.value === "missing" && (operation.method !== "constant" || fields["value-type"].value === "null"))
			operation.value = null;
		return parseTransformSpec(
			{ version: 1, datasetVersionId: context.dataset.currentVersionId, operation },
			context.dataset.schema,
			context.dataset.currentVersionId,
		);
	}
	function facts(entries: [string, string][]): HTMLDListElement {
		const list = node("dl", undefined, "profile-facts");
		for (const [key, value] of entries) list.append(node("dt", key), node("dd", value));
		return list;
	}
	function code(title: string, text: string): HTMLDetailsElement {
		const details = node("details", undefined, "chart-disclosure");
		const content = node("pre", text, "chart-code transform-code");
		content.tabIndex = 0;
		content.setAttribute("aria-label", title);
		details.append(node("summary", title), content);
		return details;
	}
	function table(title: string, headers: string[], rows: (string | null)[][]): HTMLElement {
		const scroll = node("div", undefined, "table-scroll");
		scroll.tabIndex = 0;
		scroll.setAttribute("role", "region");
		scroll.setAttribute("aria-label", title);
		const result = node("table");
		result.append(node("caption", title));
		const head = node("thead");
		const header = node("tr");
		for (const name of headers) {
			const cell = node("th", name);
			cell.scope = "col";
			header.append(cell);
		}
		head.append(header);
		const body = node("tbody");
		for (const row of rows) {
			const tr = node("tr");
			for (const value of row) {
				const cell = node("td");
				const content = node(
					"div",
					value === null ? "NULL" : value === "" ? "∅ (empty string)" : value,
					"cell-value",
				);
				if (value !== null && (value.length > 32 || value.includes("\n"))) {
					content.tabIndex = 0;
					content.setAttribute("role", "region");
					content.setAttribute("aria-label", "Scrollable transformation value");
				}
				cell.append(content);
				tr.append(cell);
			}
			body.append(tr);
		}
		result.append(head, body);
		scroll.append(result);
		if (!rows.length) scroll.append(node("p", "No rows.", "table-footnote"));
		return scroll;
	}
	function renderImpact(target: HTMLElement, impact: TransformImpact): void {
		target.append(
			facts([
				["Affected rows (exact, full dataset)", String(impact.affectedRows)],
				["Rows before", String(impact.inputRows)],
				["Rows after", String(impact.rowCount)],
				["Input version", impact.inputVersionId],
				["Input SHA-256", impact.inputHash],
				["Engine", impact.engineVersion],
			]),
			node(
				"p",
				"Affected means removed rows for filter/deduplication, changed values for cast/map/imputation, and all rows for schema changes or appended columns.",
				"table-footnote",
			),
		);
		const warnings = node("ul", undefined, "chart-warnings");
		warnings.append(...impact.warnings.map((value) => node("li", value)));
		target.append(
			node("h3", "Warnings"),
			impact.warnings.length ? warnings : node("p", "No warnings reported.", "muted"),
		);
		target.append(
			table(
				"Exact null changes",
				["Column", "Before", "After"],
				impact.nullChanges.map((change) => [
					change.name,
					change.before === null ? "Not present" : String(change.before),
					change.after === null ? "Not present" : String(change.after),
				]),
			),
		);
		target.append(
			table(
				"Schema before",
				["Index", "Name", "Basic type", "Native type"],
				impact.schemaBefore.map((column) => [
					String(column.index),
					column.name,
					column.basicType,
					column.sourceType,
				]),
			),
			table(
				"Schema after",
				["Index", "Name", "Basic type", "Native type"],
				impact.schema.map((column) => [String(column.index), column.name, column.basicType, column.sourceType]),
			),
		);
		target.append(
			node(
				"p",
				"First 20 input/output rows at most, in deterministic order. These are separate bounded samples, not an aligned row diff. Impact counts above describe the full dataset.",
				"table-footnote",
			),
		);
		target.append(
			table(
				"Before sample",
				impact.schemaBefore.map((column) => column.name),
				impact.before,
			),
			table(
				"After sample",
				impact.schema.map((column) => column.name),
				impact.after,
			),
		);
		target.append(
			code("Validated transformation specification", JSON.stringify(impact.spec, null, 2)),
			code("Equivalent generated SQL (inspect only)", impact.sql),
		);
	}
	async function runPreview(): Promise<void> {
		if (!context || blocked || busy) return;
		let spec: TransformSpec;
		try {
			spec = readSpec();
		} catch (reason) {
			error.textContent = reason instanceof Error ? reason.message : "Invalid specification.";
			return;
		}
		invalidate();
		const owner = context;
		const request = generation;
		const controller = new AbortController();
		requestAbort = controller;
		setBusy("preview");
		status.textContent = "Computing exact impact and staging the full transformed dataset…";
		try {
			const value = await options.api<TransformPreview>(`${route(owner)}/preview`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ spec }),
				signal: controller.signal,
			});
			if (request !== generation || !same(owner)) {
				void discard(value, owner);
				return;
			}
			if (
				value.projectId !== owner.projectId ||
				value.datasetId !== owner.dataset.id ||
				value.impact.inputVersionId !== owner.dataset.currentVersionId ||
				JSON.stringify(value.impact.spec) !== JSON.stringify(spec)
			) {
				void discard(value, owner);
				throw new Error(
					"Preview does not match the requested dataset version and specification. Preview again before approving.",
				);
			}
			const expires = Date.parse(value.expiresAt) - Date.now();
			if (!Number.isFinite(expires) || expires <= 0) {
				void discard(value, owner);
				throw new Error("Preview expired. Request a new preview.");
			}
			preview = value;
			previewSpec = JSON.stringify(spec);
			impactPanel.append(
				node("h3", "Review exact impact"),
				facts([
					["Preview ID", value.id],
					["Expires", value.expiresAt],
				]),
			);
			renderImpact(impactPanel, value.impact);
			expiryTimer = window.setTimeout(() => {
				invalidate();
				status.textContent = "Preview expired. Preview again and approve the new result.";
			}, expires);
			status.textContent = "Preview ready. Review the impact, SQL and warnings, then explicitly approve to apply.";
			void loadHistory();
		} catch (reason) {
			if (request === generation && same(owner) && !controller.signal.aborted) {
				error.textContent = reason instanceof Error ? reason.message : options.message(reason);
				status.textContent = "Preview failed. No version was applied. Edit the parameters or try again.";
				void loadHistory();
			}
		} finally {
			if (request === generation && same(owner)) {
				requestAbort = null;
				setBusy(null);
			}
		}
	}
	async function mutate(action: "apply" | "undo" | "redo"): Promise<void> {
		if (!context || blocked || busy) return;
		const owner = context;
		let body: { previewId: string; approved: true } | { expectedVersionId: string };
		if (action === "apply") {
			if (!preview || !approval.checked) return;
			try {
				if (JSON.stringify(readSpec()) !== previewSpec || Date.parse(preview.expiresAt) <= Date.now())
					throw new Error("Parameters or preview changed. Preview and approve again.");
			} catch (reason) {
				invalidate();
				error.textContent = reason instanceof Error ? reason.message : "Preview and approve again.";
				return;
			}
			body = { previewId: preview.id, approved: true };
			if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
		} else {
			if (!(action === "undo" ? history?.canUndo : history?.canRedo)) return;
			invalidate();
			body = { expectedVersionId: owner.dataset.currentVersionId };
		}
		const request = ++generation;
		historyGeneration++;
		historyAbort?.abort();
		const controller = new AbortController();
		requestAbort = controller;
		approval.checked = false;
		error.textContent = "";
		setBusy(action);
		status.textContent =
			action === "apply"
				? "Publishing the approved immutable version…"
				: `${action === "undo" ? "Undoing" : "Redoing"} the active version…`;
		try {
			const value = await options.api<Dataset>(`${route(owner)}/${action}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (request !== generation || !same(owner)) return;
			if (value.projectId !== owner.projectId || value.id !== owner.dataset.id)
				throw new Error("The server returned a different dataset. Reload the current dataset before continuing.");
			preview = null;
			previewSpec = "";
			setBusy(null);
			await options.onChanged(value);
		} catch (reason) {
			if (request === generation && same(owner) && !controller.signal.aborted) {
				invalidate();
				error.textContent = options.message(reason);
				status.textContent =
					"The version change could not be confirmed. Reload the dataset before retrying; no automatic retry or approval occurs.";
				void loadHistory();
			}
		} finally {
			if (request === generation && same(owner)) {
				requestAbort = null;
				setBusy(null);
			}
		}
	}
	async function loadHistory(): Promise<void> {
		if (!context || disposed) return;
		const owner = context;
		const request = ++historyGeneration;
		historyAbort?.abort();
		const controller = new AbortController();
		historyAbort = controller;
		historyStatus.textContent = "Loading persisted history…";
		try {
			const value = await options.api<TransformHistory>(`${route(owner)}/history`, { signal: controller.signal });
			if (request !== historyGeneration || !same(owner)) return;
			history = value.currentVersionId === owner.dataset.currentVersionId ? value : null;
			historyStatus.textContent = !history
				? "The server active version changed. Reload the dataset before transforming."
				: value.records.length
					? `${value.records.length} persisted records · active version ${value.currentVersionId}`
					: "No transformations yet. Preview an operation to start its history.";
			if (!history && preview) invalidate();
			historyList.replaceChildren();
			for (const record of value.records) {
				const item = node("details", undefined, "chart-disclosure");
				item.append(
					node("summary", `${record.spec.operation.kind} · ${record.state} · ${record.createdAt}`),
					facts([
						["Record", record.id],
						["Actor", record.actor],
						["Created", record.createdAt],
						["Completed", record.completedAt ?? "Not completed"],
						["Input version", record.inputVersionId],
						["Output version", record.outputVersionId ?? "Not applied"],
						["State", record.state],
					]),
					code("Operation and parameters", JSON.stringify(record.spec, null, 2)),
				);
				if (record.error) item.append(node("p", record.error, "inline-error"));
				if (record.result) {
					const result = record.result;
					item.addEventListener("toggle", () => {
						if (!item.open || item.dataset.resultRendered) return;
						item.dataset.resultRendered = "true";
						renderImpact(item, result);
					});
				} else item.append(node("p", "No execution result recorded.", "table-footnote"));
				historyList.append(item);
			}
		} catch (reason) {
			if (request === historyGeneration && same(owner) && !controller.signal.aborted) {
				history = null;
				historyStatus.textContent = `${options.message(reason)} Use Refresh history to retry.`;
			}
		} finally {
			if (request === historyGeneration && same(owner)) sync();
		}
	}
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void runPreview();
	});
	kind.addEventListener("change", () => {
		invalidate();
		buildFields();
		status.textContent = "Operation changed. Preview again before approving.";
	});
	parameters.addEventListener("input", () => {
		invalidate();
		syncVariants();
		status.textContent = "Parameters changed. Previous approval cleared; preview again.";
	});
	parameters.addEventListener("change", () => {
		invalidate();
		syncVariants();
		status.textContent = "Parameters changed. Previous approval cleared; preview again.";
	});
	approval.addEventListener("change", sync);
	function clear(): void {
		invalidate();
		historyGeneration++;
		historyAbort?.abort();
		context = null;
		history = null;
		historyList.replaceChildren();
		historyStatus.textContent = "Select a dataset to load its persisted transformation history.";
		status.textContent = "";
		active.textContent = "Select a dataset to transform.";
		buildFields();
		sync();
	}
	buildFields();
	sync();
	return {
		update(next) {
			if (context && same(next)) {
				context = next;
				sync();
				return;
			}
			clear();
			context = next;
			active.textContent = `${next.dataset.name} · active version ${next.dataset.currentVersionId} · ${next.dataset.rowCount} rows`;
			buildFields();
			sync();
			if (!container.hidden) void loadHistory();
			else historyStatus.textContent = "Open Transform to load persisted version history.";
		},
		clear,
		setBlocked(value) {
			blocked = value;
			sync();
		},
		acceptProposal(spec) {
			if (!context || busy === "apply" || busy === "undo" || busy === "redo") return;
			invalidate();
			try {
				const validated = parseTransformSpec(spec, context.dataset.schema, context.dataset.currentVersionId);
				kind.value = validated.operation.kind;
				buildFields(validated.operation);
				status.textContent =
					"Assistant proposal loaded for review only. Inspect the parameters, preview the full impact, then explicitly approve. Nothing has been applied.";
				heading.focus();
			} catch (reason) {
				error.textContent =
					reason instanceof Error ? reason.message : "Proposal does not match this dataset version.";
			}
			sync();
		},
		dispose() {
			visibility.disconnect();
			clear();
			disposed = true;
		},
	};
}
