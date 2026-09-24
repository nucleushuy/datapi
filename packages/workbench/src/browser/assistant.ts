import type {
	AssistantChartPreview,
	AssistantDraft,
	AssistantModel,
	AssistantModels,
	AssistantRun,
	AssistantSelection,
	AssistantSuggestion,
} from "../assistant-contracts.ts";
import type { ChartFilter, ChartSpec } from "../chart-contracts.ts";
import type { Dataset } from "../contracts.ts";
import type { DatasetProfile } from "../profile-contracts.ts";
import { renderChart } from "./chart-renderer.ts";

export interface AssistantUiContext {
	projectId: string;
	dataset: Dataset;
	profile: DatasetProfile | null;
	selectedColumns: number[];
	filters: ChartFilter[];
	revision: number;
}
interface AssistantOptions {
	api<T>(path: string, options?: RequestInit): Promise<T>;
	message(error: unknown): string;
	currentContext(): AssistantUiContext | null;
	onProfile(): void;
	onSuggestions(): void;
	onOpenChart(spec: ChartSpec): void;
	onPrivacy(state: string, detail: string): void;
}
export interface AssistantController {
	update(context: AssistantUiContext): void;
	clear(): void;
	setBlocked(blocked: boolean): void;
	dispose(): void;
}

export function initializeAssistant(
	container: HTMLElement,
	suggestionsContainer: HTMLElement,
	options: AssistantOptions,
): AssistantController {
	const document = container.ownerDocument;
	const window = document.defaultView!;
	let context: AssistantUiContext | null = null;
	let contextKey = "";
	let selectedColumns = new Set<number>();
	let generation = 0;
	let revision = 0;
	let disposed = false;
	let opened = false;
	let blocked = true;
	let models: AssistantModel[] = [];
	let modelBusy = false;
	let historyBusy = false;
	let preparing = false;
	let sending = false;
	let mutating = false;
	let credentialBusy = false;
	let draft: AssistantDraft | null = null;
	let draftKey = "";
	let draftTimer: number | undefined;
	let pollTimer: number | undefined;
	let pollAbort: AbortController | null = null;
	let draftAbort: AbortController | null = null;
	let selectedRunId = "";
	let historyLoaded = false;
	const requests = new Set<AbortController>();
	const runs = new Map<string, AssistantRun>();
	const previews = new Map<string, { result: AssistantChartPreview; expires: number }>();
	let previewTimer: number | undefined;

	function node<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		text?: string,
		className?: string,
	): HTMLElementTagNameMap[K] {
		const value = document.createElement(tag);
		if (text !== undefined) value.textContent = text;
		if (className) value.className = className;
		return value;
	}
	function button(id: string, text: string, action: () => void, primary = false): HTMLButtonElement {
		const value = node("button", text, `button${primary ? " button-primary" : ""}`);
		value.id = id;
		value.type = "button";
		value.addEventListener("click", action);
		return value;
	}
	function field(labelText: string, control: HTMLElement): HTMLElement {
		const value = node("div", undefined, "chart-control");
		const label = node("label", labelText);
		label.htmlFor = control.id;
		value.append(label, control);
		return value;
	}
	function facts(entries: [string, string][]): HTMLDListElement {
		const value = node("dl", undefined, "profile-facts chart-metadata");
		for (const [label, text] of entries) value.append(node("dt", label), node("dd", text));
		return value;
	}
	function inspect(label: string, text: string): HTMLDetailsElement {
		const value = node("details", undefined, "chart-disclosure");
		const pre = node("pre", text, "chart-code assistant-exact");
		pre.tabIndex = 0;
		pre.setAttribute("aria-label", label);
		value.append(node("summary", label), pre);
		return value;
	}
	function feedback(id: string, alert = false): HTMLParagraphElement {
		const value = node("p", undefined, alert ? "inline-error" : "muted");
		value.id = id;
		value.setAttribute("role", alert ? "alert" : "status");
		value.hidden = true;
		return value;
	}
	function say(target: HTMLElement, text: string): void {
		target.textContent = text;
		target.hidden = !text;
	}
	function controller(): AbortController {
		const value = new window.AbortController();
		requests.add(value);
		return value;
	}
	function current(owner: number, signal: AbortSignal): boolean {
		return !disposed && owner === generation && !signal.aborted;
	}
	function path(): string {
		return `/api/projects/${encodeURIComponent(context!.projectId)}/datasets/${encodeURIComponent(context!.dataset.id)}/assistant`;
	}
	function json(body: unknown): RequestInit {
		return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
	}
	function selectedRun(): AssistantRun | undefined {
		return runs.get(selectedRunId);
	}
	function chosenModel(): AssistantModel | undefined {
		return models.find((item) => item.provider === provider.value && item.id === model.value);
	}
	function readyProfile(): boolean {
		return Boolean(context?.profile && context.profile.datasetVersionId === context.dataset.currentVersionId);
	}
	function refreshContext(): void {
		const value = options.currentContext();
		if (value) update(value);
		else clear();
	}
	function selection(): AssistantSelection {
		return {
			datasetVersionId: context!.dataset.currentVersionId,
			selectedColumns: context!.dataset.schema
				.filter((column) => selectedColumns.has(column.index))
				.map((column) => column.index),
			filters: context!.filters,
			request: request.value,
			provider: provider.value,
			modelId: model.value,
		};
	}
	function selectionKey(): string {
		return JSON.stringify([contextKey, selection()]);
	}
	function scoped(run: AssistantRun): boolean {
		return run.projectId === context?.projectId && run.datasetId === context.dataset.id;
	}
	function assertRun(run: AssistantRun, id?: string): void {
		if (!scoped(run) || (id !== undefined && run.id !== id))
			throw new Error("The server returned a different assistant run. Refresh history before continuing.");
	}

	container.classList.add("assistant-workspace");
	suggestionsContainer.classList.add("assistant-workspace");
	const gate = node("p", undefined, "profile-basis");
	gate.id = "assistant-context-status";
	const open = button("assistant-open", "Set up assistant / load history", () => {
		if (!context || blocked) return;
		opened = true;
		sync();
		void loadModels();
		void loadHistory();
	});
	const profileButton = button("assistant-profile", "Find Run profile", options.onProfile);
	const form = node("div", undefined, "assistant-stack");
	const provider = node("select");
	provider.id = "assistant-provider";
	const model = node("select");
	model.id = "assistant-model";
	const modelStatus = feedback("assistant-model-status");
	const modelError = feedback("assistant-model-error", true);
	const refreshModels = button("assistant-refresh-models", "Refresh models", () => {
		void loadModels();
	});
	const credentials = node("details", undefined, "chart-disclosure");
	const apiKey = node("input");
	apiKey.id = "assistant-api-key";
	apiKey.type = "password";
	apiKey.autocomplete = "new-password";
	apiKey.spellcheck = false;
	apiKey.maxLength = 8192;
	const saveKey = button("assistant-save-key", "Save server API key", () => {
		void saveCredential(false);
	});
	const deleteKey = button("assistant-delete-key", "Delete API key…", () => {
		deleteKeyConfirmation.hidden = false;
		deleteKeyText.textContent = `Delete the workbench server API key for ${provider.value}? Existing run history is retained.`;
		confirmDeleteKey.focus();
	});
	const credentialStatus = feedback("assistant-credential-status");
	const credentialError = feedback("assistant-credential-error", true);
	const deleteKeyConfirmation = node("div", undefined, "chart-delete-confirmation");
	deleteKeyConfirmation.hidden = true;
	const deleteKeyText = node("p");
	const confirmDeleteKey = button("assistant-confirm-delete-key", "Confirm delete key", () => {
		void saveCredential(true);
	});
	const keepKey = button("assistant-keep-key", "Keep key", () => {
		deleteKeyConfirmation.hidden = true;
		deleteKey.focus();
	});
	deleteKeyConfirmation.append(deleteKeyText, confirmDeleteKey, keepKey);
	const keyActions = node("div", undefined, "button-row");
	keyActions.append(saveKey, deleteKey);
	credentials.append(
		node("summary", "Provider credentials · server only"),
		node(
			"p",
			"Use a literal API key for the selected provider. It is sent only to this local server, never stored in browser preferences or run history. Ambient Pi credentials and OAuth are not used.",
		),
		field("API key", apiKey),
		keyActions,
		credentialStatus,
		credentialError,
		deleteKeyConfirmation,
	);
	const request = node("textarea");
	request.id = "assistant-request";
	request.rows = 5;
	request.maxLength = 4000;
	request.placeholder = "What would you like to investigate? Name the fields and measures you mean.";
	request.setAttribute("aria-describedby", "assistant-request-help");
	const requestHelp = node(
		"p",
		"Each request is independent: no previous conversation is sent. Read-only suggestions and validated chart proposals only; no transformations or code execution.",
		"muted",
	);
	requestHelp.id = "assistant-request-help";
	const selectionSummary = node("div");
	selectionSummary.id = "assistant-selection";
	const columnPicker = node("fieldset", undefined, "assistant-column-picker assistant-stack");
	columnPicker.append(node("legend", "Fields to share · choose up to 32"));
	const columnChoices = node("div", undefined, "assistant-column-choices");
	columnChoices.id = "assistant-columns";
	const columnStatus = feedback("assistant-column-status");
	const columnActions = node("div", undefined, "button-row");
	const useCurrentColumns = button("assistant-use-current-columns", "Use current data / chart selection", () => {
		refreshContext();
		selectedColumns = new Set(context?.selectedColumns.slice(0, 32) ?? []);
		invalidateDraft("Sharing selection changed. Review a fresh payload.");
		renderColumnChoices();
		sync();
	});
	const useDefaultColumns = button("assistant-use-default-columns", "Use first 24 fields", () => {
		selectedColumns = new Set(context?.dataset.schema.slice(0, 24).map((column) => column.index) ?? []);
		invalidateDraft("Sharing selection changed. Review a fresh payload.");
		renderColumnChoices();
		sync();
	});
	columnActions.append(useCurrentColumns, useDefaultColumns);
	columnPicker.append(
		node(
			"p",
			"Choose the fields needed for your question without building a chart first. Initial selection: first 24 fields. Current chart filter fields are additionally disclosed; inspect their names and literal values below.",
		),
		columnChoices,
		columnStatus,
		columnActions,
	);
	const prepare = button(
		"assistant-prepare",
		"Review exact payload",
		() => {
			void prepareDraft();
		},
		true,
	);
	const fresh = button("assistant-new-request", "New independent request", () => {
		invalidateDraft("");
		request.value = "";
		say(error, "");
		say(status, "Write a new request, then review a fresh payload. History is retained but never retransmitted.");
		sync();
		request.focus();
	});
	const prepareActions = node("div", undefined, "button-row");
	prepareActions.append(prepare, fresh);
	const status = feedback("assistant-status");
	const error = feedback("assistant-error", true);
	const review = node("section", undefined, "assistant-review assistant-stack");
	review.id = "assistant-review";
	review.hidden = true;
	const reviewContents = node("div", undefined, "assistant-stack");
	const reviewed = node("input");
	reviewed.id = "assistant-reviewed";
	reviewed.type = "checkbox";
	const reviewedLabel = node("label", undefined, "assistant-check");
	reviewedLabel.htmlFor = reviewed.id;
	reviewedLabel.append(
		reviewed,
		node("span", "I reviewed the exact system and user messages and approve sharing them with this provider."),
	);
	const send = button(
		"assistant-send",
		"Approve and send",
		() => {
			void sendDraft();
		},
		true,
	);
	review.append(reviewContents, reviewedLabel, send);
	form.append(
		field("Provider recipient", provider),
		field("Model", model),
		modelStatus,
		modelError,
		refreshModels,
		credentials,
		field("Independent request", request),
		requestHelp,
		columnPicker,
		selectionSummary,
		prepareActions,
		status,
		error,
		review,
	);
	const history = node("section", undefined, "assistant-stack assistant-history");
	const runSelect = node("select");
	runSelect.id = "assistant-runs";
	const historyStatus = feedback("assistant-history-status");
	const historyError = feedback("assistant-history-error", true);
	const refreshHistory = button("assistant-refresh-history", "Refresh run history", () => {
		void loadHistory();
	});
	const runDetail = node("section", undefined, "assistant-stack");
	runDetail.id = "assistant-run";
	runDetail.setAttribute("aria-label", "Selected assistant run");
	const runActions = node("div", undefined, "button-row");
	const cancel = button("assistant-cancel", "Cancel generation", () => {
		void cancelRun();
	});
	const checkRun = button("assistant-check-run", "Check run status", () => {
		void checkSelectedRun();
	});
	const showSuggestions = button("assistant-show-suggestions", "Review suggestions", options.onSuggestions);
	runActions.append(cancel, checkRun, showSuggestions);
	history.append(
		node("h3", "Dataset run history"),
		field("Run", runSelect),
		historyStatus,
		historyError,
		refreshHistory,
		runDetail,
		runActions,
	);
	container.replaceChildren(
		node("p", "PI / EXPLICIT APPROVAL", "eyebrow"),
		node("h3", "Ask with evidence."),
		node(
			"p",
			"Review every outgoing message before it leaves this machine. Full rows, tools, ambient files and earlier turns are never attached.",
		),
		gate,
		profileButton,
		open,
		form,
		history,
	);

	function invalidateDraft(reason: string): void {
		revision++;
		draftAbort?.abort();
		draftAbort = null;
		preparing = false;
		draft = null;
		draftKey = "";
		reviewed.checked = false;
		review.hidden = true;
		reviewContents.replaceChildren();
		window.clearTimeout(draftTimer);
		if (reason) say(status, reason);
	}
	function renderModels(): void {
		const previousProvider = provider.value;
		const previousModel = model.value;
		provider.replaceChildren(
			...[...new Set(models.map((item) => item.provider))].map((name) => {
				const option = node(
					"option",
					`${name} · ${models.some((item) => item.provider === name && item.configured) ? "configured" : "not configured"}`,
				);
				option.value = name;
				return option;
			}),
		);
		if (models.some((item) => item.provider === previousProvider)) provider.value = previousProvider;
		renderModelChoices(previousModel);
	}
	function renderModelChoices(preferred = ""): void {
		model.replaceChildren(
			...models
				.filter((item) => item.provider === provider.value)
				.map((item) => {
					const option = node(
						"option",
						`${item.name} (${item.id}) · ${item.configured ? "configured" : "API key required"}`,
					);
					option.value = item.id;
					return option;
				}),
		);
		if (models.some((item) => item.provider === provider.value && item.id === preferred)) model.value = preferred;
	}
	function renderColumnChoices(): void {
		columnChoices.replaceChildren(
			...(context?.dataset.schema ?? []).map((column) => {
				const label = node("label", undefined, "assistant-check");
				const checkbox = node("input");
				checkbox.type = "checkbox";
				checkbox.id = `assistant-column-${column.index}`;
				checkbox.value = String(column.index);
				checkbox.checked = selectedColumns.has(column.index);
				label.htmlFor = checkbox.id;
				label.append(checkbox, node("span", `${column.name} · ${column.sourceType}`));
				checkbox.addEventListener("change", () => {
					if (checkbox.checked && selectedColumns.size < 32) selectedColumns.add(column.index);
					else {
						selectedColumns.delete(column.index);
						checkbox.checked = false;
					}
					invalidateDraft("Fields to share changed. Review a fresh payload before sending.");
					sync();
				});
				return label;
			}),
		);
	}
	function sync(): void {
		const hasProfile = readyProfile();
		gate.textContent = !context
			? "Select a dataset, then run its deterministic profile to prepare an assistant request."
			: !hasProfile
				? `${context.dataset.name}: a current saved profile is required. History and provider setup are still available.`
				: `${context.dataset.name} · profile ready · 0 source rows attached`;
		profileButton.hidden = !context || hasProfile;
		open.hidden = opened;
		open.disabled = !context || blocked;
		form.hidden = !opened;
		history.hidden = !opened;
		provider.disabled = modelBusy || credentialBusy || sending || !models.length;
		model.disabled = provider.disabled;
		refreshModels.disabled = modelBusy || credentialBusy || sending || !context;
		refreshModels.textContent = modelBusy ? "Loading models…" : "Refresh models";
		apiKey.disabled = credentialBusy || sending || !provider.value;
		saveKey.disabled = apiKey.disabled || !apiKey.value;
		deleteKey.disabled = credentialBusy || sending || !chosenModel()?.configured;
		confirmDeleteKey.disabled = credentialBusy;
		keepKey.disabled = credentialBusy;
		request.disabled = sending;
		fresh.disabled = sending;
		columnPicker.disabled = sending || !context;
		for (const checkbox of columnChoices.querySelectorAll<HTMLInputElement>("input"))
			checkbox.disabled = !checkbox.checked && selectedColumns.size >= 32;
		say(
			columnStatus,
			`${selectedColumns.size} / 32 selected. ${selectedColumns.size === 0 ? "Select at least one field before preparing; no hidden default will be sent." : "Only selected fields and current filter fields will be disclosed."}`,
		);
		prepare.disabled =
			!opened ||
			!hasProfile ||
			blocked ||
			preparing ||
			sending ||
			modelBusy ||
			credentialBusy ||
			!chosenModel()?.configured ||
			!request.value.trim() ||
			request.value.length > 4000 ||
			!selectedColumns.size ||
			[...runs.values()].some((run) => run.state === "running");
		prepare.textContent = preparing ? "Preparing local review…" : "Review exact payload";
		send.disabled =
			!draft || !reviewed.checked || sending || blocked || !hasProfile || Date.parse(draft.expiresAt) <= Date.now();
		send.textContent = sending ? "Sending approved payload…" : "Approve and send";
		reviewed.disabled = sending;
		refreshHistory.disabled = historyBusy || sending || mutating || !context;
		runSelect.disabled = !runs.size || historyBusy || sending || mutating;
		const run = selectedRun();
		cancel.hidden = run?.state !== "running";
		cancel.disabled = mutating;
		checkRun.disabled = !run || mutating || historyBusy;
		showSuggestions.disabled = !run || run.state !== "completed";
		if (context)
			selectionSummary.replaceChildren(
				facts([
					[
						"Selected columns",
						context.dataset.schema
							.filter((column) => selectedColumns.has(column.index))
							.map((column) => column.name)
							.join(", ") || "None — choose at least one",
					],
					["Current chart filters", JSON.stringify(context.filters)],
					[
						"Additional filter fields",
						context.dataset.schema
							.filter(
								(column) =>
									!selectedColumns.has(column.index) &&
									context!.filters.some((filter) => filter.column === column.index),
							)
							.map((column) => column.name)
							.join(", ") || "None",
					],
					[
						"Context",
						"Project metadata, selected/filter-field schema and deterministic statistics, literal filters and saved artifact metadata. Names and literal filters may be sensitive.",
					],
					["Data rows / samples sent", "0 rows · no cell samples"],
				]),
			);
		for (const action of suggestionsContainer.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
			action.disabled = mutating || blocked || action.dataset.unavailable === "true";
		}
	}
	async function loadModels(): Promise<void> {
		if (!opened || !context || modelBusy || credentialBusy) return;
		const owner = generation;
		const abort = controller();
		modelBusy = true;
		invalidateDraft("Provider metadata refreshed. Review a new payload before sending.");
		say(modelError, "");
		sync();
		try {
			const result = await options.api<AssistantModels>("/api/assistant/models", { signal: abort.signal });
			if (!current(owner, abort.signal)) return;
			models = result.models;
			renderModels();
			say(
				modelStatus,
				result.guidance ||
					(models.length
						? "Choose a provider and model. Only configured models can receive an approved request."
						: "No supported models available. Check the server configuration, then Refresh models."),
			);
		} catch (failure) {
			if (current(owner, abort.signal)) say(modelError, options.message(failure));
		} finally {
			requests.delete(abort);
			if (owner === generation) {
				modelBusy = false;
				sync();
			}
		}
	}
	async function saveCredential(remove: boolean): Promise<void> {
		if (credentialBusy || !provider.value || (remove ? deleteKeyConfirmation.hidden : !apiKey.value)) return;
		const owner = generation;
		const recipient = provider.value;
		const abort = controller();
		const init = remove ? { method: "DELETE" } : json({ provider: recipient, apiKey: apiKey.value });
		apiKey.value = "";
		credentialBusy = true;
		invalidateDraft("Credentials changed. Prepare a new review after configuration finishes.");
		say(credentialError, "");
		say(credentialStatus, "");
		sync();
		try {
			await options.api(`/api/assistant/credentials${remove ? `/${encodeURIComponent(recipient)}` : ""}`, {
				...init,
				signal: abort.signal,
			});
			if (!current(owner, abort.signal)) return;
			deleteKeyConfirmation.hidden = true;
			say(
				credentialStatus,
				`${recipient}: server API key ${remove ? "deleted" : "saved"}. The input has been cleared.`,
			);
		} catch {
			// Never echo a credential endpoint response: it could contain the submitted secret.
			if (current(owner, abort.signal))
				say(
					credentialError,
					"The credential change could not be confirmed. Refresh models to check configuration, then re-enter the key if needed. The input has been cleared.",
				);
		} finally {
			requests.delete(abort);
			if (owner === generation) {
				apiKey.value = "";
				credentialBusy = false;
				sync();
				void loadModels();
			}
		}
	}
	async function prepareDraft(): Promise<void> {
		refreshContext();
		sync();
		if (prepare.disabled || !context) return;
		invalidateDraft("");
		const owner = generation;
		const version = revision;
		const snapshot = selectionKey();
		const abort = controller();
		draftAbort = abort;
		preparing = true;
		say(error, "");
		say(status, "Constructing the exact payload locally. Nothing is sent to the model during preparation.");
		sync();
		try {
			const result = await options.api<AssistantDraft>(`${path()}/prepare`, {
				...json(selection()),
				signal: abort.signal,
			});
			if (!current(owner, abort.signal) || version !== revision) return;
			refreshContext();
			if (version !== revision || snapshot !== selectionKey()) return;
			if (
				result.projectId !== context?.projectId ||
				result.datasetId !== context.dataset.id ||
				result.provider !== provider.value ||
				result.modelId !== model.value ||
				result.context.dataset.versionId !== context.dataset.currentVersionId
			)
				throw new Error("The prepared payload does not match this selection. Prepare a fresh review.");
			draft = result;
			draftKey = snapshot;
			reviewed.checked = false;
			reviewContents.replaceChildren(
				node("h3", "Review before sharing"),
				facts([
					["Recipient", `${result.provider} / ${result.modelId}`],
					["Project / dataset", `${result.context.project.name} / ${result.context.dataset.name}`],
					[
						"Version / artifact hash",
						`${result.context.dataset.versionId} / ${result.context.dataset.artifactHash}`,
					],
					[
						"Included metadata",
						`${result.context.schema.length} schema fields · ${result.context.selectedColumns.length} selected fields · ${result.context.filters.length} filters · ${result.context.evidence.length} profile facts · ${result.context.artifacts.length} saved artifacts`,
					],
					["Data rows / cell samples", "0 rows · no cell samples · no conversation history"],
					["Expires", result.expiresAt],
					["Payload hash", result.payloadHash],
				]),
				node("h4", "Exact system message"),
				exactMessage("assistant-system-payload", result.payload.system),
				node("h4", "Exact user message"),
				exactMessage("assistant-user-payload", result.payload.user),
				inspect("Context metadata and limitations", JSON.stringify(result.context, null, 2)),
			);
			review.hidden = false;
			say(
				status,
				"Prepared locally. Inspect both exact messages, then check the approval box. Preparation alone does not contact the provider.",
			);
			draftTimer = window.setTimeout(
				() => {
					invalidateDraft("This approval draft expired. Prepare and review a fresh payload.");
					sync();
				},
				Math.max(0, Date.parse(result.expiresAt) - Date.now()),
			);
			reviewed.focus();
		} catch (failure) {
			if (current(owner, abort.signal) && version === revision) say(error, options.message(failure));
		} finally {
			requests.delete(abort);
			if (owner === generation && version === revision) {
				preparing = false;
				draftAbort = null;
				sync();
			}
		}
	}
	function exactMessage(id: string, text: string): HTMLPreElement {
		const value = node("pre", text, "chart-code assistant-exact");
		value.id = id;
		value.tabIndex = 0;
		value.setAttribute(
			"aria-label",
			id === "assistant-system-payload" ? "Exact system message" : "Exact user message",
		);
		return value;
	}
	async function sendDraft(): Promise<void> {
		refreshContext();
		sync();
		if (!draft || send.disabled || !context) return;
		if (draftKey !== selectionKey()) {
			invalidateDraft("Selection changed. Review a fresh payload.");
			sync();
			return;
		}
		const approved = draft;
		const owner = generation;
		const abort = controller();
		sending = true;
		say(error, "");
		options.onPrivacy(
			`Approved for ${approved.provider}`,
			`${approved.modelId} · selected metadata only · 0 rows · delivery pending`,
		);
		sync();
		try {
			const run = await options.api<AssistantRun>(`${path()}/runs`, {
				...json({ draftId: approved.id, payloadHash: approved.payloadHash }),
				signal: abort.signal,
			});
			if (!current(owner, abort.signal)) return;
			assertRun(run);
			runs.set(run.id, run);
			selectedRunId = run.id;
			invalidateDraft("");
			renderHistory();
			renderRun();
			say(
				status,
				"Approved request started. Only activity counts are shown until the complete response passes validation.",
			);
			schedulePoll();
		} catch (failure) {
			if (current(owner, abort.signal)) {
				invalidateDraft("");
				say(
					error,
					`${options.message(failure)} Refresh history to check whether the approved run started before preparing another request.`,
				);
				say(status, "Delivery is not confirmed. No automatic retry was made.");
			}
		} finally {
			requests.delete(abort);
			if (owner === generation) {
				sending = false;
				sync();
			}
		}
	}
	function renderHistory(): void {
		const ordered = [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		runSelect.replaceChildren(
			...ordered.map((run) => {
				const option = node("option", `${run.state} · ${run.createdAt} · ${run.request.slice(0, 80)}`);
				option.value = run.id;
				return option;
			}),
		);
		if (!runs.has(selectedRunId)) selectedRunId = ordered[0]?.id ?? "";
		runSelect.value = selectedRunId;
		say(
			historyStatus,
			historyBusy
				? "Loading dataset run history…"
				: runs.size
					? `${runs.size} saved runs for this dataset. Earlier turns are not attached to new requests.`
					: historyLoaded
						? "No saved runs yet. Write a request and review its exact payload to begin."
						: "Load history explicitly to inspect this dataset’s approved runs.",
		);
		sync();
	}
	async function loadHistory(): Promise<void> {
		if (!opened || !context || historyBusy || mutating) return;
		const owner = generation;
		const abort = controller();
		historyBusy = true;
		say(historyError, "");
		renderHistory();
		try {
			const loaded = await options.api<AssistantRun[]>(`${path()}/runs`, { signal: abort.signal });
			if (!current(owner, abort.signal)) return;
			for (const run of loaded) assertRun(run);
			runs.clear();
			for (const run of loaded) runs.set(run.id, run);
			historyLoaded = true;
			clearPreviews();
			renderHistory();
			renderRun();
			schedulePoll();
		} catch (failure) {
			if (current(owner, abort.signal)) say(historyError, options.message(failure));
		} finally {
			requests.delete(abort);
			if (owner === generation) {
				historyBusy = false;
				renderHistory();
			}
		}
	}
	function renderRun(): void {
		const run = selectedRun();
		runDetail.replaceChildren();
		if (!run) {
			renderSuggestions();
			sync();
			return;
		}
		options.onPrivacy(
			run.receivedCharacters > 0 || run.state === "completed"
				? `Metadata shared with ${run.provider}`
				: `Approved for ${run.provider}`,
			`${run.modelId} · ${run.state} · 0 rows · dataset ${run.context.dataset.name}`,
		);
		const state = node("p", `${run.state.toUpperCase()} · ${run.provider} / ${run.modelId}`, "state-label");
		state.id = "assistant-run-state";
		state.setAttribute("role", "status");
		const metrics = facts([
			["Received output", `${run.receivedCharacters} characters · raw model output withheld until validation`],
			["Tokens", `${run.usage.input} input · ${run.usage.output} output · ${run.usage.totalTokens} total`],
			["Cache tokens", `${run.usage.cacheRead} read · ${run.usage.cacheWrite} written`],
			["Latency", `${run.latencyMs} ms`],
			["Dataset version", run.datasetVersionId],
		]);
		metrics.id = "assistant-run-metrics";
		runDetail.append(state, node("p", run.request), metrics);
		if (run.error) runDetail.append(node("p", run.error, "inline-error"));
		if (run.state === "failed" || run.state === "cancelled")
			runDetail.append(
				node(
					"p",
					"This run remains in history. Edit or start an independent request and review a new payload to try again. No silent repair or retry.",
				),
			);
		if (run.state === "completed")
			runDetail.append(node("p", "AI inference · not verified", "profile-basis"), node("p", run.summary));
		runDetail.append(inspect("Approved context snapshot · metadata only", JSON.stringify(run.context, null, 2)));
		renderSuggestions();
		sync();
	}
	function schedulePoll(): void {
		if (
			disposed ||
			!context ||
			pollTimer !== undefined ||
			pollAbort ||
			![...runs.values()].some((run) => run.state === "running")
		)
			return;
		pollTimer = window.setTimeout(() => {
			pollTimer = undefined;
			const running = [...runs.values()].find((run) => run.state === "running");
			if (running) void pollRun(running.id);
		}, 800);
	}
	async function pollRun(id: string): Promise<void> {
		if (!context || mutating || historyBusy) {
			schedulePoll();
			return;
		}
		const owner = generation;
		const abort = controller();
		pollAbort = abort;
		let succeeded = false;
		try {
			const run = await options.api<AssistantRun>(`${path()}/runs/${encodeURIComponent(id)}`, {
				signal: abort.signal,
			});
			if (!current(owner, abort.signal)) return;
			assertRun(run, id);
			runs.set(id, run);
			say(historyError, "");
			renderHistory();
			if (selectedRunId === id) renderRun();
			succeeded = true;
		} catch (failure) {
			if (current(owner, abort.signal))
				say(
					historyError,
					`${options.message(failure)} Monitoring paused; use Check run status or Refresh run history. Cancellation remains available.`,
				);
		} finally {
			requests.delete(abort);
			if (pollAbort === abort) pollAbort = null;
			if (owner === generation && succeeded) schedulePoll();
		}
	}
	async function checkSelectedRun(): Promise<void> {
		if (!selectedRunId || pollAbort) return;
		await pollRun(selectedRunId);
	}
	function stopPoll(): void {
		window.clearTimeout(pollTimer);
		pollTimer = undefined;
		pollAbort?.abort();
		pollAbort = null;
	}
	async function cancelRun(): Promise<void> {
		const run = selectedRun();
		if (!run || run.state !== "running" || mutating || !context) return;
		const owner = generation;
		const abort = controller();
		stopPoll();
		mutating = true;
		say(historyError, "");
		say(historyStatus, "Cancelling generation; waiting for the provider worker to settle…");
		sync();
		try {
			const result = await options.api<AssistantRun>(`${path()}/runs/${encodeURIComponent(run.id)}`, {
				method: "DELETE",
				signal: abort.signal,
			});
			if (!current(owner, abort.signal)) return;
			assertRun(result, run.id);
			runs.set(result.id, result);
			renderHistory();
			renderRun();
		} catch (failure) {
			if (current(owner, abort.signal))
				say(
					historyError,
					`${options.message(failure)} Cancellation is not confirmed. Check run status or try Cancel again.`,
				);
		} finally {
			requests.delete(abort);
			if (owner === generation) {
				mutating = false;
				sync();
				schedulePoll();
			}
		}
	}
	function clearPreviews(): void {
		previews.clear();
		window.clearTimeout(previewTimer);
		previewTimer = undefined;
	}
	function renderSuggestions(): void {
		const focused = suggestionsContainer.contains(document.activeElement) ? document.activeElement?.id : undefined;
		const disclosures = new Set(
			[...suggestionsContainer.querySelectorAll<HTMLDetailsElement>("details[open][data-disclosure]")].map(
				(item) => item.dataset.disclosure,
			),
		);
		const run = selectedRun();
		suggestionsContainer.replaceChildren(
			node("p", "AI INFERENCES / REVIEW REQUIRED", "eyebrow"),
			node("h3", "Evidence is not verification."),
			node(
				"p",
				"References link to observed facts; they do not verify the model’s interpretation. Accept is a review decision, not a data transformation.",
			),
		);
		if (!run || run.state !== "completed") {
			suggestionsContainer.append(
				node(
					"p",
					run?.state === "running"
						? "Generation is in progress. Raw output is withheld until the complete response passes schema validation."
						: run
							? `${run.state}: no validated suggestions. Inspect the run in Assistant, then prepare a new request if needed.`
							: "Open Assistant and load this dataset’s history, or prepare an independent request. Select a completed run to inspect its suggestions.",
				),
			);
			return;
		}
		suggestionsContainer.append(
			node("p", `${run.provider} / ${run.modelId} · ${run.createdAt} · ${run.context.dataset.name}`, "muted"),
		);
		if (!run.suggestions.length)
			suggestionsContainer.append(
				node(
					"p",
					"No actionable suggestion was returned. Review the summary; clarify ambiguous fields or unsupported measures in a new request.",
				),
			);
		for (const suggestion of run.suggestions) {
			const article = node("article", undefined, "assistant-suggestion assistant-stack");
			article.id = `assistant-suggestion-${suggestion.id}`;
			article.dataset.status = suggestion.status;
			article.append(
				node("p", `${suggestion.category} · ${suggestion.priority} priority · ${suggestion.status}`, "state-label"),
				node("h4", suggestion.title),
				node(
					"p",
					suggestion.basis === "evidence-linked"
						? "AI inference · evidence-linked, not verified"
						: "AI hypothesis · requires validation",
					"profile-basis",
				),
				node("p", suggestion.explanation),
				facts([
					["Model-reported confidence", `${suggestion.confidence} · not calibrated or verified`],
					[
						"Affected columns",
						suggestion.affectedColumns
							.map(
								(index) =>
									run.context.schema.find((column) => column.index === index)?.name ?? `Column ${index}`,
							)
							.join(", ") || "Dataset-wide",
					],
				]),
			);
			const evidence = node("details", undefined, "chart-disclosure");
			evidence.dataset.disclosure = `evidence-${suggestion.id}`;
			evidence.append(node("summary", `Inspect ${suggestion.evidenceRefs.length} referenced facts`));
			if (!suggestion.evidenceRefs.length)
				evidence.append(
					node("p", "No supporting references. Treat this as a hypothesis requiring independent validation."),
				);
			for (const reference of suggestion.evidenceRefs) {
				const value = run.context.evidence.find((item) => item.id === reference);
				evidence.append(
					value
						? facts([
								["Reference / metric", `${value.id} / ${value.metric}`],
								["Reported value", value.value === null ? "Not available (null)" : String(value.value)],
								[
									"Basis",
									`${value.basis} · ${value.rows} rows · ${value.basis === "sample" ? "sample only, not population" : "full scan"}`,
								],
								[
									"Approximate",
									value.approximate ? "Yes — approximate statistic" : "No — exact within stated basis only",
								],
								[
									"Columns",
									value.columns
										.map(
											(index) =>
												run.context.schema.find((column) => column.index === index)?.name ?? String(index),
										)
										.join(", ") || "Dataset-wide",
								],
							])
						: node("p", `Unresolved reference ${reference}. This claim is not verified.`, "inline-error"),
				);
			}
			article.append(evidence);
			if (suggestion.generatedCode !== null) {
				const code = inspect("Generated code · inspect only, never executed", suggestion.generatedCode);
				code.dataset.disclosure = `code-${suggestion.id}`;
				article.append(code);
			}
			if (suggestion.error) article.append(node("p", suggestion.error, "inline-error"));
			const actions = node("div", undefined, "button-row");
			function action(
				name: string,
				text: string,
				callback: () => void,
				unavailable = false,
				primary = false,
			): HTMLButtonElement {
				const value = button(`assistant-${name}-${suggestion.id}`, text, callback, primary);
				value.dataset.action = name;
				value.dataset.unavailable = String(unavailable);
				value.disabled = mutating || blocked || unavailable;
				actions.append(value);
				return value;
			}
			if (!["applied", "reverted"].includes(suggestion.status)) {
				action(
					"accept",
					suggestion.status === "failed" ? "Accept to retry preview" : "Accept",
					() => {
						void changeSuggestion(suggestion, "status", { status: "accepted" });
					},
					suggestion.status === "accepted",
				);
				action(
					"reject",
					"Reject",
					() => {
						void changeSuggestion(suggestion, "status", { status: "rejected" });
					},
					suggestion.status === "rejected",
				);
			}
			if (suggestion.proposedAction.kind === "read-only")
				article.append(
					node("p", suggestion.proposedAction.description),
					node(
						"p",
						"Read-only proposal. Acceptance records your review; it does not execute code or change data.",
					),
				);
			else {
				const spec = suggestion.proposedAction.spec;
				const stale = run.datasetVersionId !== context?.dataset.currentVersionId;
				const specDetails = inspect(
					"Validated chart specification · not yet a verified claim",
					JSON.stringify(spec, null, 2),
				);
				specDetails.dataset.disclosure = `spec-${suggestion.id}`;
				article.append(specDetails);
				if (stale)
					article.append(
						node(
							"p",
							"This proposal belongs to an earlier dataset version. It cannot be previewed, applied or opened against the current version.",
							"profile-basis",
						),
					);
				const cached = previews.get(suggestion.id);
				const preview = cached && cached.expires > Date.now() ? cached.result : null;
				if (suggestion.status === "accepted") {
					action(
						"preview",
						preview ? "Refresh chart preview" : "Preview chart locally",
						() => {
							void changeSuggestion(suggestion, "preview", {});
						},
						stale,
					);
					action(
						"apply",
						"Apply · save chart configuration",
						() => {
							if (preview) void changeSuggestion(suggestion, "apply", { previewId: preview.previewId });
						},
						stale || !preview,
						true,
					);
					if (!preview)
						article.append(
							node(
								"p",
								"Preview the exact chart first. Applying saves only its configuration; original rows remain unchanged.",
							),
						);
				}
				if (preview) {
					const canvas = node("div", undefined, "chart-canvas assistant-preview");
					canvas.id = `assistant-preview-canvas-${suggestion.id}`;
					const chart = preview.chart;
					renderChart(canvas, chart);
					article.append(
						node("h5", "Local deterministic preview · not saved"),
						canvas,
						facts([
							[
								"Sample",
								`${chart.sampleSize} / ${chart.populationRows} rows · ${chart.sampled ? "sample only, not population estimates" : "all rows"} · stride ${chart.stride} · byte cap ${chart.byteLimited ? "reached" : "not reached"}`,
							],
							["Filters", `${chart.labels.filters} · ${chart.filteredRows} rows remain`],
							["Aggregation", chart.labels.aggregation],
							["Missing / invalid", `${chart.labels.missing} · ${chart.excludedRows} excluded`],
							["Display", `${chart.marks.length} marks · ${chart.omittedMarks} omitted`],
						]),
					);
					const warnings = node("ul", undefined, "chart-warnings");
					warnings.append(...chart.warnings.map((warning) => node("li", warning)));
					article.append(warnings);
				}
				if (suggestion.status === "applied") {
					article.append(
						node("p", `Saved chart configuration: ${suggestion.chartId}. Original data is unchanged.`),
					);
					action(
						"open-chart",
						"Open chart in Visualize",
						() => {
							try {
								options.onOpenChart(spec);
							} catch (failure) {
								say(suggestionError, options.message(failure));
							}
						},
						stale,
					);
					const confirmation = node("div", undefined, "chart-delete-confirmation");
					confirmation.hidden = true;
					const revert = action("revert", "Revert chart…", () => {
						confirmation.hidden = false;
						confirm.focus();
					});
					const confirm = button(`assistant-confirm-revert-${suggestion.id}`, "Confirm chart-only revert", () => {
						void changeSuggestion(suggestion, "revert", {});
					});
					confirm.dataset.action = "confirm-revert";
					confirm.disabled = mutating || blocked;
					const keep = button(`assistant-keep-chart-${suggestion.id}`, "Keep chart", () => {
						confirmation.hidden = true;
						revert.focus();
					});
					confirmation.append(
						node(
							"p",
							"Delete only the chart configuration created by this suggestion? Original data and run history remain. Edited charts are protected and cannot be reverted here.",
						),
						confirm,
						keep,
					);
					article.append(confirmation);
				}
			}
			article.append(actions);
			suggestionsContainer.append(article);
		}
		suggestionsContainer.append(suggestionStatus, suggestionError);
		for (const details of suggestionsContainer.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]"))
			details.open = disclosures.has(details.dataset.disclosure);
		if (focused) document.getElementById(focused)?.focus();
	}
	const suggestionStatus = feedback("assistant-suggestion-status");
	const suggestionError = feedback("assistant-suggestion-error", true);
	async function changeSuggestion(
		suggestion: AssistantSuggestion,
		action: "status" | "preview" | "apply" | "revert",
		body: unknown,
	): Promise<void> {
		const run = selectedRun();
		if (!context || !run || mutating || blocked) return;
		const owner = generation;
		const abort = controller();
		const endpoint = `${path()}/runs/${encodeURIComponent(run.id)}/suggestions/${encodeURIComponent(suggestion.id)}/${action}`;
		mutating = true;
		stopPoll();
		say(suggestionError, "");
		say(
			suggestionStatus,
			action === "preview" ? "Computing bounded chart preview locally…" : "Saving review decision…",
		);
		if (action !== "apply") previews.delete(suggestion.id);
		sync();
		try {
			if (action === "preview") {
				const result = await options.api<AssistantChartPreview>(endpoint, { ...json(body), signal: abort.signal });
				if (!current(owner, abort.signal) || selectedRunId !== run.id) return;
				if (
					suggestion.proposedAction.kind !== "chart" ||
					!Object.entries(suggestion.proposedAction.spec).every(
						([key, value]) => JSON.stringify(result.chart.spec[key as keyof ChartSpec]) === JSON.stringify(value),
					) ||
					result.chart.datasetVersionHash !== run.context.dataset.artifactHash
				)
					throw new Error(
						"The preview does not match the approved chart and dataset artifact. It cannot be applied.",
					);
				if (previews.size >= 8) previews.delete(previews.keys().next().value!);
				previews.set(suggestion.id, { result, expires: Date.now() + 10 * 60_000 });
				window.clearTimeout(previewTimer);
				previewTimer = window.setTimeout(
					() => {
						clearPreviews();
						renderSuggestions();
						sync();
					},
					Math.max(0, Math.min(...[...previews.values()].map((item) => item.expires)) - Date.now()),
				);
				say(suggestionStatus, "Preview ready. Inspect filters, aggregation and sample limitations before Apply.");
			} else {
				const result = await options.api<AssistantRun>(endpoint, { ...json(body), signal: abort.signal });
				if (!current(owner, abort.signal)) return;
				assertRun(result, run.id);
				runs.set(result.id, result);
				previews.delete(suggestion.id);
				say(
					suggestionStatus,
					action === "apply"
						? "Chart configuration saved. Open it explicitly in Visualize; no source data changed."
						: action === "revert"
							? "Owned chart configuration reverted. Source data and run history are unchanged."
							: "Review status saved. No data transformation was performed.",
				);
			}
		} catch (failure) {
			if (current(owner, abort.signal)) {
				previews.delete(suggestion.id);
				say(suggestionStatus, "");
				say(
					suggestionError,
					`${options.message(failure)} Check the current status before retrying; history is retained.`,
				);
				try {
					const updated = await options.api<AssistantRun>(`${path()}/runs/${encodeURIComponent(run.id)}`, {
						signal: abort.signal,
					});
					if (current(owner, abort.signal)) {
						assertRun(updated, run.id);
						runs.set(run.id, updated);
					}
				} catch {
					/* Keep the known run visible; Refresh history remains available. */
				}
			}
		} finally {
			requests.delete(abort);
			if (owner === generation) {
				mutating = false;
				renderHistory();
				renderRun();
				sync();
			}
		}
	}
	provider.addEventListener("change", () => {
		apiKey.value = "";
		deleteKeyConfirmation.hidden = true;
		say(credentialStatus, "");
		say(credentialError, "");
		renderModelChoices();
		invalidateDraft("Provider changed. Review a fresh payload for this recipient.");
		sync();
	});
	model.addEventListener("change", () => {
		invalidateDraft("Model changed. Review a fresh payload.");
		sync();
	});
	request.addEventListener("input", () => {
		invalidateDraft("Request changed. Review a fresh payload before sending.");
		sync();
	});
	apiKey.addEventListener("input", sync);
	reviewed.addEventListener("change", sync);
	runSelect.addEventListener("change", () => {
		selectedRunId = runSelect.value;
		clearPreviews();
		say(suggestionError, "");
		say(suggestionStatus, "");
		renderRun();
	});
	const theme = new window.MutationObserver(() => {
		if (previews.size) renderSuggestions();
	});
	theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	function update(next: AssistantUiContext): void {
		if (disposed) return;
		const sameScope =
			context?.projectId === next.projectId &&
			context.dataset.id === next.dataset.id &&
			context.dataset.currentVersionId === next.dataset.currentVersionId;
		if (!sameScope) clear();
		const key = JSON.stringify([
			next.projectId,
			next.dataset.id,
			next.dataset.currentVersionId,
			next.profile?.datasetVersionHash,
			next.profile?.profiledAt,
			next.selectedColumns,
			next.filters,
			next.revision,
		]);
		if (key !== contextKey)
			invalidateDraft(
				sameScope ? "Dataset context, selected fields or chart specification changed. Review a fresh payload." : "",
			);
		contextKey = key;
		context = next;
		if (!sameScope) selectedColumns = new Set(next.dataset.schema.slice(0, 24).map((column) => column.index));
		if (!sameScope || key !== columnChoices.dataset.contextKey) {
			renderColumnChoices();
			columnChoices.dataset.contextKey = key;
		}
		sync();
	}
	function clear(): void {
		generation++;
		stopPoll();
		for (const abort of requests) abort.abort();
		requests.clear();
		clearPreviews();
		invalidateDraft("");
		context = null;
		contextKey = "";
		selectedColumns.clear();
		columnChoices.replaceChildren();
		delete columnChoices.dataset.contextKey;
		opened = false;
		modelBusy = historyBusy = preparing = sending = mutating = credentialBusy = false;
		models = [];
		provider.replaceChildren();
		model.replaceChildren();
		apiKey.value = "";
		request.value = "";
		credentials.open = false;
		deleteKeyConfirmation.hidden = true;
		runs.clear();
		selectedRunId = "";
		historyLoaded = false;
		selectionSummary.replaceChildren();
		for (const target of [
			modelStatus,
			modelError,
			credentialStatus,
			credentialError,
			status,
			error,
			historyStatus,
			historyError,
			suggestionStatus,
			suggestionError,
		])
			say(target, "");
		renderHistory();
		renderRun();
		sync();
	}
	clear();
	return {
		update,
		clear,
		setBlocked(value) {
			if (blocked !== value) {
				blocked = value;
				sync();
			}
		},
		dispose() {
			disposed = true;
			clear();
			theme.disconnect();
			container.replaceChildren();
			suggestionsContainer.replaceChildren();
		},
	};
}
