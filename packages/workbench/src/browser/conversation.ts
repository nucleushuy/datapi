import {
	ASSISTANT_ATTACHMENT_FILE_BYTES,
	ASSISTANT_ATTACHMENT_MAX_FILES,
	ASSISTANT_ATTACHMENT_TOTAL_BYTES,
	type AssistantAttachment,
	type AssistantAttachmentInput,
	type AssistantContext,
	type AssistantExecutionReference,
	type AssistantModels,
} from "../assistant-contracts.ts";
import type { ChartFilter, ChartRecord } from "../chart-contracts.ts";
import type { Dataset } from "../contracts.ts";
import type { Conversation, ConversationEvent } from "../conversation-contracts.ts";
import type { DatasetProfile } from "../profile-contracts.ts";
import type { TransformHistory } from "../transform-contracts.ts";

export interface ConversationUiContext {
	projectId: string;
	dataset: Dataset;
	profile: DatasetProfile | null;
	selectedColumns: number[];
	filters: ChartFilter[];
	revision: number;
}

interface ConversationOptions {
	api<T>(path: string, options?: RequestInit): Promise<T>;
	stream(path: string, message: string, onEvent: (event: ConversationEvent) => void): Promise<Conversation>;
	message(error: unknown): string;
}

export interface ConversationController {
	update(context: ConversationUiContext | null): void;
	dispose(): void;
}

type DraftAttachment = AssistantAttachmentInput & { byteLength: number };

export function initializeConversation(container: HTMLElement, options: ConversationOptions): ConversationController {
	const document = container.ownerDocument;
	let context: ConversationUiContext | null = null;
	let conversation: Conversation | null = null;
	let partial = "";
	let optimisticMessage: string | null = null;
	let sending = false;
	let loadingSessions = false;
	let readingFiles = false;
	let disposed = false;
	let scopeGeneration = 0;
	let viewGeneration = 0;
	let modelGeneration = 0;
	let metadataGeneration = 0;
	let sessions: Conversation[] = [];
	let attachments: DraftAttachment[] = [];
	let executionIds = new Set<string>();
	let charts: AssistantContext["artifacts"] = [];
	let executions: AssistantExecutionReference[] = [];
	let streamStatus = "";
	let feedbackError = "";
	let chartStatus = "";
	let executionStatus = "";
	const models = new Map<string, string[]>();
	const configuredProviders = ["anthropic", "openai", "google", "mistral", "xai", "groq", "openrouter", "cerebras"];

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
	function option(text: string): HTMLOptionElement {
		const value = node("option", text);
		value.value = text;
		return value;
	}
	const heading = node("h2", "Ask about this dataset");
	const disclosure = node(
		"p",
		"Read-only chat shares dataset metadata and your messages with the chosen provider, never automatic row samples. Optional files are shared only after your consent and Send; they are never executed.",
		"muted",
	);
	const messages = node("div", undefined, "assistant-history");
	const sessionList = node("ul", undefined, "chat-session-list");
	const newSession = node("button", "New chat", "button");
	newSession.id = "conversation-new";
	newSession.type = "button";
	const sidebar = node("aside", undefined, "chat-session-sidebar");
	sidebar.append(node("h3", "Sessions"), newSession, sessionList);
	messages.setAttribute("aria-live", "polite");
	const scopeDetails = node("details", undefined, "chat-context");
	scopeDetails.open = true;
	const scopeSummary = node("summary", "Context to share");
	const scopeChips = node("ul", undefined, "chat-context-chips");
	scopeChips.id = "conversation-context";
	const scopeNote = node("p", undefined, "muted");
	const fileInput = node("input");
	fileInput.id = "conversation-files";
	fileInput.type = "file";
	fileInput.multiple = true;
	fileInput.accept = ".py,.sql,.txt,.md,.json";
	const fileLabel = node("label", "Attach text files");
	fileLabel.htmlFor = fileInput.id;
	const fileHelp = node(
		"p",
		`UTF-8 .py, .sql, .txt, .md, .json only. Up to ${ASSISTANT_ATTACHMENT_MAX_FILES} files, ${ASSISTANT_ATTACHMENT_FILE_BYTES / 1024} KiB each, ${ASSISTANT_ATTACHMENT_TOTAL_BYTES / 1024} KiB total. Inspect before sharing.`,
		"muted",
	);
	const fileList = node("ul", undefined, "chat-file-list");
	fileList.id = "conversation-file-list";
	const fileConsent = node("input");
	fileConsent.id = "conversation-file-consent";
	fileConsent.type = "checkbox";
	const consentLabel = node("label", undefined, "assistant-check");
	consentLabel.append(
		fileConsent,
		node(
			"span",
			"I consent to save these file contents in this chat and send them to the selected provider when I press Send. They remain frozen for later messages.",
		),
	);
	const resultPicker = node("fieldset", undefined, "assistant-column-picker");
	resultPicker.append(node("legend", "Optional execution results"));
	const resultChoices = node("div", undefined, "chat-result-choices");
	resultChoices.id = "conversation-executions";
	resultPicker.append(
		node(
			"p",
			"Select up to 8 saved results. Only IDs, status, versions, operation kind, timestamps and numeric impact counts are shared — not code, preview cells or errors.",
			"muted",
		),
		resultChoices,
	);
	scopeDetails.append(
		scopeSummary,
		scopeChips,
		scopeNote,
		fileLabel,
		fileInput,
		fileHelp,
		fileList,
		consentLabel,
		resultPicker,
	);
	const provider = node("select");
	provider.id = "conversation-provider";
	const model = node("select");
	model.id = "conversation-model";
	const controls = node("div", undefined, "chart-control-grid");
	const providerLabel = node("label", "Provider");
	providerLabel.htmlFor = provider.id;
	const modelLabel = node("label", "Model");
	modelLabel.htmlFor = model.id;
	const providerField = node("div", undefined, "chart-control");
	providerField.append(providerLabel, provider);
	const modelField = node("div", undefined, "chart-control");
	modelField.append(modelLabel, model);
	controls.append(providerField, modelField);
	const setup = node("details");
	const setupSummary = node("summary", "Connect a provider");
	const credentialProvider = node("select");
	credentialProvider.id = "conversation-credential-provider";
	for (const name of configuredProviders) credentialProvider.append(option(name));
	const credentialKey = node("input");
	credentialKey.id = "conversation-api-key";
	credentialKey.type = "password";
	credentialKey.autocomplete = "off";
	credentialKey.placeholder = "API key";
	const connect = node("button", "Connect", "button");
	connect.type = "button";
	const credentialField = node("div", undefined, "chart-control-grid");
	const credentialProviderLabel = node("label", "Provider");
	credentialProviderLabel.htmlFor = credentialProvider.id;
	const credentialKeyLabel = node("label", "API key");
	credentialKeyLabel.htmlFor = credentialKey.id;
	const credentialProviderControl = node("div", undefined, "chart-control");
	credentialProviderControl.append(credentialProviderLabel, credentialProvider);
	const credentialKeyControl = node("div", undefined, "chart-control");
	credentialKeyControl.append(credentialKeyLabel, credentialKey);
	credentialField.append(credentialProviderControl, credentialKeyControl);
	setup.append(setupSummary, credentialField, connect);
	const form = node("form", undefined, "assistant-form");
	const input = node("textarea");
	input.id = "conversation-message";
	input.rows = 3;
	input.maxLength = 16 * 1024;
	input.placeholder = "Ask a question about this dataset";
	input.required = true;
	const inputLabel = node("label", "Message");
	inputLabel.htmlFor = input.id;
	const send = node("button", "Send", "button button-primary");
	send.id = "conversation-send";
	send.type = "submit";
	const cancel = node("button", "Stop", "button");
	cancel.id = "conversation-stop";
	cancel.type = "button";
	cancel.hidden = true;
	const feedback = node("p", undefined, "muted");
	feedback.id = "conversation-feedback";
	feedback.setAttribute("role", "status");
	const actions = node("div", undefined, "assistant-actions");
	actions.append(send, cancel);
	form.append(controls, setup, inputLabel, input, actions, feedback);
	const chatMain = node("section", undefined, "chat-transcript");
	chatMain.append(heading, disclosure, scopeDetails, messages, form);
	const chatShell = node("div", undefined, "chat-shell");
	chatShell.append(sidebar, chatMain);
	container.replaceChildren(chatShell);

	function datasetPath(): string {
		if (!context) throw new Error("Choose a dataset before starting a conversation.");
		return `/api/projects/${encodeURIComponent(context.projectId)}/datasets/${encodeURIComponent(context.dataset.id)}`;
	}
	function current(owner: number): boolean {
		return !disposed && owner === viewGeneration;
	}
	function busy(): boolean {
		return sending || conversation?.state === "running";
	}
	function remember(value: Conversation): void {
		sessions = [value, ...sessions.filter((item) => item.id !== value.id)];
	}
	function clearDraft(): void {
		attachments = [];
		executionIds = new Set();
		fileConsent.checked = false;
		fileInput.value = "";
		readingFiles = false;
	}
	function clearTranscript(): void {
		partial = "";
		optimisticMessage = null;
		streamStatus = "";
		feedbackError = "";
	}
	function resultText(item: AssistantExecutionReference): string {
		const counts = Object.entries(item.impact ?? {})
			.map(([key, value]) => `${key}: ${value}`)
			.join(", ");
		return `${item.kind} · ${item.state} · ${item.id} · ${item.inputVersionId} → ${item.outputVersionId ?? "no output"} · ${item.createdAt}${item.completedAt ? ` · completed ${item.completedAt}` : ""}${counts ? ` · ${counts}` : ""}`;
	}
	function renderContext(): void {
		const frozen = conversation?.scope.context;
		scopeSummary.textContent = frozen ? "Frozen chat context" : "Context to share";
		scopeChips.replaceChildren();
		const chip = (text: string) => scopeChips.append(node("li", text));
		if (context) {
			const dataset = frozen?.dataset;
			chip(`Dataset: ${dataset?.name ?? context.dataset.name}`);
			chip(`Version: ${dataset?.versionId ?? context.dataset.currentVersionId}`);
			chip(
				`${dataset?.rowCount ?? context.dataset.rowCount} rows · ${dataset?.columnCount ?? context.dataset.columnCount} columns · no row samples`,
			);
			if (frozen) {
				const basis = [
					...new Set(
						frozen.evidence.map(
							(item) => `${item.basis}${item.approximate ? " approximate" : ""} · ${item.rows} rows`,
						),
					),
				];
				chip(`Profile: ${frozen.evidence.length} frozen metrics${basis.length ? ` · ${basis.join("; ")}` : ""}`);
				chip(`Provider: ${conversation!.scope.provider} / ${conversation!.scope.modelId}`);
			} else {
				const profile = context.profile;
				chip(
					profile
						? `Profile: v${profile.profilerVersion} · ${profile.sampling.method} · ${profile.sampling.sampleSize} rows · ${profile.profiledAt}`
						: "Profile: loaded on Send; no cached rich profile",
				);
			}
			const schema = frozen?.schema ?? context.dataset.schema;
			const selected = frozen?.selectedColumns ?? context.selectedColumns;
			chip(
				`Columns: ${selected.length ? selected.map((index) => schema.find((item) => item.index === index)?.name ?? `#${index}`).join(", ") : "all"}`,
			);
			const filters = frozen?.filters ?? context.filters;
			chip(
				`Filters: ${filters.length ? filters.map((item) => `${schema.find((column) => column.index === item.column)?.name ?? `#${item.column}`} ${item.op}${item.op === "is-null" || item.op === "not-null" ? "" : ` ${item.value}`}`).join("; ") : "none"}`,
			);
			const artifacts = frozen?.artifacts ?? charts;
			if (!artifacts.length) chip(frozen ? "Charts: none" : chartStatus || "Charts: none");
			for (const item of artifacts) chip(`Chart: ${item.name} · ${item.type} · version ${item.datasetVersionId}`);
		} else chip("Choose a dataset to view its context.");
		scopeNote.textContent = frozen
			? "This saved scope, including files and result references, is reused unchanged. Start a New chat to change it."
			: "Dataset/profile, selected columns, filters and saved chart metadata are frozen on Send. File contents stay only in this browser until you consent and Send.";
		fileInput.hidden = fileLabel.hidden = fileHelp.hidden = !!frozen;
		const files = frozen?.attachedFiles ?? (frozen ? [] : attachments);
		fileList.replaceChildren();
		for (const [index, file] of files.entries()) {
			const entry = node("li");
			const inspect = node("details");
			inspect.append(
				node("summary", `${file.name} · ${file.byteLength} bytes${frozen ? " · saved" : " · local draft"}`),
			);
			if (frozen)
				inspect.append(
					node(
						"p",
						`SHA-256: ${(file as AssistantAttachment).sha256 ?? "not recorded in this legacy chat"}`,
						"chat-file-hash",
					),
				);
			inspect.append(node("pre", file.content, "assistant-exact"));
			entry.append(inspect);
			if (!frozen) {
				const remove = node("button", "Remove", "button");
				remove.type = "button";
				remove.setAttribute("aria-label", `Remove ${file.name}`);
				remove.addEventListener("click", () => {
					if (busy() || readingFiles) return;
					attachments.splice(index, 1);
					fileConsent.checked = false;
					renderContext();
					render();
				});
				entry.append(remove);
			}
			fileList.append(entry);
		}
		consentLabel.hidden = !!frozen || !attachments.length;
		resultChoices.replaceChildren();
		const results = frozen?.executionResults ?? (frozen ? [] : executions);
		if (!results.length)
			resultChoices.append(
				node(
					"p",
					frozen ? "No execution results shared." : executionStatus || "No saved execution results.",
					"muted",
				),
			);
		for (const item of results) {
			if (frozen) resultChoices.append(node("p", resultText(item)));
			else {
				const check = node("input");
				check.type = "checkbox";
				check.value = item.id;
				check.checked = executionIds.has(item.id);
				const label = node("label", undefined, "assistant-check");
				label.append(check, node("span", resultText(item)));
				check.addEventListener("change", () => {
					if (busy() || loadingSessions) return;
					if (check.checked && executionIds.size < 8) executionIds.add(item.id);
					else {
						executionIds.delete(item.id);
						check.checked = false;
					}
					render();
				});
				resultChoices.append(label);
			}
		}
	}
	function render(): void {
		if (disposed) return;
		const active = busy();
		sessionList.replaceChildren();
		for (const item of sessions) {
			const select = node("button", item.title, "button");
			select.type = "button";
			select.disabled = active || item.id === conversation?.id;
			select.addEventListener("click", () => {
				if (busy()) return;
				++viewGeneration;
				conversation = structuredClone(item);
				clearDraft();
				clearTranscript();
				input.value = "";
				populateModels();
				renderContext();
				render();
			});
			const entry = node("li");
			entry.append(select);
			sessionList.append(entry);
		}
		messages.replaceChildren();
		if (!conversation)
			messages.append(node("p", "Start a conversation. Review the context above before sending.", "muted"));
		for (const item of conversation?.messages ?? []) {
			const message = node("article", undefined, `assistant-history-item conversation-${item.role}`);
			message.append(node("strong", item.role === "user" ? "You" : "Assistant"), node("p", item.text));
			messages.append(message);
		}
		if (optimisticMessage) {
			const message = node("article", undefined, "assistant-history-item conversation-user");
			message.append(node("strong", "You"), node("p", optimisticMessage));
			messages.append(message);
		}
		if (partial) {
			const message = node("article", undefined, "assistant-history-item conversation-assistant");
			message.append(node("strong", "Assistant"), node("p", partial));
			messages.append(message);
		}
		newSession.disabled = !context || active;
		input.disabled = !context || active;
		provider.disabled = model.disabled = !context || active || !!conversation;
		fileInput.disabled = fileConsent.disabled =
			!context || active || loadingSessions || readingFiles || !!conversation;
		for (const button of fileList.querySelectorAll("button")) button.disabled = active || readingFiles;
		for (const check of resultChoices.querySelectorAll("input"))
			check.disabled = loadingSessions || active || (!check.checked && executionIds.size >= 8);
		send.disabled =
			!context ||
			active ||
			loadingSessions ||
			readingFiles ||
			!input.value.trim() ||
			(!conversation && (!model.value || (attachments.length > 0 && !fileConsent.checked)));
		cancel.hidden = !active || !conversation;
		feedback.textContent =
			feedbackError ||
			conversation?.error ||
			streamStatus ||
			(readingFiles
				? "Reading files locally…"
				: loadingSessions
					? "Loading chats…"
					: active
						? "Pi is responding…"
						: "");
		feedback.hidden = !feedback.textContent;
	}
	function populateModels(): void {
		const selectedProvider = conversation?.scope.provider ?? provider.value;
		provider.replaceChildren();
		for (const [name] of models) provider.append(option(name));
		if (selectedProvider && !models.has(selectedProvider) && conversation) provider.append(option(selectedProvider));
		provider.value = [...provider.options].some((item) => item.value === selectedProvider)
			? selectedProvider
			: (provider.options[0]?.value ?? "");
		populateModelOptions();
	}
	function populateModelOptions(): void {
		const selected = conversation?.scope.modelId ?? model.value;
		model.replaceChildren();
		for (const id of models.get(provider.value) ?? []) model.append(option(id));
		if (conversation && ![...model.options].some((item) => item.value === selected)) model.append(option(selected));
		model.value = [...model.options].some((item) => item.value === selected)
			? selected
			: (model.options[0]?.value ?? "");
	}
	async function loadModels(): Promise<void> {
		const owner = ++modelGeneration;
		try {
			const result = await options.api<AssistantModels>("/api/chat/models");
			if (disposed || owner !== modelGeneration) return;
			models.clear();
			for (const item of result.models.filter((item) => item.configured)) {
				const values = models.get(item.provider) ?? [];
				values.push(item.id);
				models.set(item.provider, values);
			}
			populateModels();
			if (!models.size) feedbackError = "Configure a provider API key before sending a chat message.";
		} catch (error) {
			if (disposed || owner !== modelGeneration) return;
			feedbackError = options.message(error);
		}
		render();
	}
	async function loadConversations(): Promise<void> {
		const scope = scopeGeneration;
		const view = viewGeneration;
		const endpoint = `${datasetPath()}/conversations`;
		loadingSessions = true;
		try {
			const values = await options.api<Conversation[]>(endpoint);
			if (disposed || scope !== scopeGeneration) return;
			sessions = values;
			if (current(view)) {
				conversation =
					values.find((item) => item.scope.datasetVersionId === context?.dataset.currentVersionId) ?? null;
				populateModels();
				renderContext();
			}
		} catch (error) {
			if (disposed || scope !== scopeGeneration) return;
			feedbackError = options.message(error);
		} finally {
			if (!disposed && scope === scopeGeneration) {
				loadingSessions = false;
				render();
			}
		}
	}
	async function loadMetadata(): Promise<void> {
		const owner = ++metadataGeneration;
		const endpoint = datasetPath();
		chartStatus = "Loading chart metadata…";
		executionStatus = "Loading execution results…";
		const valid = () => !disposed && owner === metadataGeneration;
		await Promise.all([
			options
				.api<ChartRecord[]>(`${endpoint}/charts`)
				.then((values) => {
					if (!valid()) return;
					charts = values
						.sort((a, b) => a.id.localeCompare(b.id))
						.slice(0, 20)
						.map((item) => ({
							id: item.id,
							name: item.name,
							type: item.spec.type,
							datasetVersionId: item.spec.datasetVersionId,
						}));
					chartStatus = "";
				})
				.catch((error) => {
					if (valid()) chartStatus = `Chart metadata unavailable: ${options.message(error)}`;
				}),
			options
				.api<TransformHistory>(`${endpoint}/transforms/history`)
				.then((history) => {
					if (!valid()) return;
					executions = history.records.map((item) => ({
						id: item.id,
						projectId: item.projectId,
						datasetId: item.datasetId,
						state: item.state,
						inputVersionId: item.inputVersionId,
						outputVersionId: item.outputVersionId,
						kind: item.spec.operation.kind,
						createdAt: item.createdAt,
						completedAt: item.completedAt,
						impact: item.result
							? Object.fromEntries(
									Object.entries({
										inputRows: item.result.inputRows,
										outputRows: item.result.rowCount,
										affectedRows: item.result.affectedRows,
										inputColumnCount: item.result.schemaBefore.length,
										outputColumnCount: item.result.schema.length,
									}).filter(([, value]) => Number.isSafeInteger(value) && value >= 0),
								)
							: null,
					}));
					executionIds = new Set([...executionIds].filter((id) => executions.some((item) => item.id === id)));
					executionStatus = "";
				})
				.catch((error) => {
					if (valid()) executionStatus = `Execution results unavailable: ${options.message(error)}`;
				}),
		]);
		if (valid()) {
			renderContext();
			render();
		}
	}
	async function readFiles(): Promise<void> {
		if (!context || conversation || busy() || loadingSessions || readingFiles) return;
		const files = [...(fileInput.files ?? [])];
		fileInput.value = "";
		if (!files.length) return;
		const owner = viewGeneration;
		fileConsent.checked = false;
		readingFiles = true;
		feedbackError = "";
		render();
		try {
			if (attachments.length + files.length > ASSISTANT_ATTACHMENT_MAX_FILES)
				throw new Error(`Choose at most ${ASSISTANT_ATTACHMENT_MAX_FILES} files.`);
			const next: DraftAttachment[] = [];
			let total = attachments.reduce((sum, item) => sum + item.byteLength, 0);
			for (const file of files) {
				if (
					file.name.length > 256 ||
					file.name !== file.name.trim() ||
					/^[.]|[.]$/.test(file.name) ||
					/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(file.name) ||
					/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name) ||
					!/\.(py|sql|txt|md|json)$/i.test(file.name)
				)
					throw new Error(
						`Unsupported attachment name: ${file.name}. Choose a plain .py, .sql, .txt, .md or .json filename.`,
					);
				if (file.size > ASSISTANT_ATTACHMENT_FILE_BYTES)
					throw new Error(`${file.name} exceeds ${ASSISTANT_ATTACHMENT_FILE_BYTES} bytes.`);
				const buffer = await file.arrayBuffer();
				if (!current(owner)) return;
				let content: string;
				try {
					content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
				} catch {
					throw new Error(`${file.name} is not valid UTF-8 text.`);
				}
				if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content))
					throw new Error(`${file.name} contains binary or control characters.`);
				const byteLength = new TextEncoder().encode(content).byteLength;
				if (byteLength > ASSISTANT_ATTACHMENT_FILE_BYTES)
					throw new Error(`${file.name} exceeds ${ASSISTANT_ATTACHMENT_FILE_BYTES} bytes.`);
				total += byteLength;
				if (total > ASSISTANT_ATTACHMENT_TOTAL_BYTES)
					throw new Error(`Attachments exceed ${ASSISTANT_ATTACHMENT_TOTAL_BYTES} bytes in total.`);
				next.push({ name: file.name, mediaType: "text/plain", content, byteLength });
			}
			attachments.push(...next);
		} catch (error) {
			if (current(owner)) feedbackError = error instanceof Error ? error.message : options.message(error);
		} finally {
			if (current(owner)) {
				readingFiles = false;
				renderContext();
				render();
			}
		}
	}
	async function sendMessage(): Promise<void> {
		if (
			!context ||
			!input.value.trim() ||
			busy() ||
			loadingSessions ||
			readingFiles ||
			(!conversation && (!model.value || (attachments.length > 0 && !fileConsent.checked)))
		)
			return;
		const owner = viewGeneration;
		const endpoint = `${datasetPath()}/conversations`;
		const message = input.value.trim();
		sending = true;
		feedbackError = "";
		partial = "";
		streamStatus = conversation ? "Pi is responding…" : "Saving approved chat context…";
		render();
		try {
			if (!conversation) {
				const value = await options.api<Conversation>(endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						datasetVersionId: context.dataset.currentVersionId,
						selectedColumns: context.selectedColumns,
						filters: context.filters,
						request: message,
						provider: provider.value,
						modelId: model.value,
						...(attachments.length
							? {
									attachments: attachments.map(({ name, mediaType, content }) => ({
										name,
										mediaType,
										content,
									})),
								}
							: {}),
						...(executionIds.size ? { executionIds: [...executionIds] } : {}),
					}),
				});
				if (!current(owner)) return;
				conversation = value;
				remember(value);
				clearDraft();
				populateModels();
				renderContext();
			}
			const id = conversation.id;
			optimisticMessage = message;
			input.value = "";
			streamStatus = "Pi is responding…";
			render();
			const value = await options.stream(`${endpoint}/${encodeURIComponent(id)}/messages`, message, (event) => {
				if (!current(owner) || event.conversationId !== id) return;
				if (event.type === "text") {
					partial += event.delta;
					streamStatus = "Pi is responding…";
				} else streamStatus = event.error ?? (event.state === "running" ? "Pi is responding…" : "");
				render();
			});
			if (!current(owner)) return;
			conversation = value;
			remember(value);
			optimisticMessage = null;
			partial = "";
			renderContext();
		} catch (error) {
			if (current(owner)) feedbackError = options.message(error);
		} finally {
			if (current(owner)) {
				sending = false;
				streamStatus = "";
				render();
			}
		}
	}
	newSession.addEventListener("click", () => {
		if (busy() || !context) return;
		++viewGeneration;
		conversation = null;
		clearDraft();
		clearTranscript();
		input.value = "";
		populateModels();
		void loadMetadata();
		renderContext();
		render();
	});
	connect.addEventListener("click", () => {
		if (!credentialKey.value) return;
		const owner = viewGeneration;
		connect.disabled = true;
		void options
			.api("/api/chat/credentials", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: credentialProvider.value, apiKey: credentialKey.value }),
			})
			.then(() => {
				if (!current(owner)) return;
				credentialKey.value = "";
				setup.open = false;
				feedbackError = "";
				void loadModels();
			})
			.catch((error) => {
				if (current(owner)) feedbackError = options.message(error);
			})
			.finally(() => {
				if (!disposed) {
					connect.disabled = false;
					render();
				}
			});
	});
	provider.addEventListener("change", () => {
		populateModelOptions();
		fileConsent.checked = false;
		render();
	});
	model.addEventListener("change", render);
	input.addEventListener("input", render);
	fileInput.addEventListener("change", () => {
		void readFiles();
	});
	fileConsent.addEventListener("change", render);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void sendMessage();
	});
	cancel.addEventListener("click", () => {
		if (!conversation) return;
		const owner = viewGeneration;
		const id = conversation.id;
		streamStatus = "Stopping Pi…";
		render();
		void options
			.api<Conversation>(`${datasetPath()}/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
			.then((value) => {
				if (!current(owner)) return;
				conversation = value;
				remember(value);
				streamStatus = "";
				if (!sending) {
					optimisticMessage = null;
					partial = "";
				}
			})
			.catch((error) => {
				if (current(owner)) {
					feedbackError = options.message(error);
					streamStatus = "";
				}
			})
			.finally(() => {
				if (current(owner)) render();
			});
	});
	return {
		update(value) {
			if (disposed) return;
			const changed =
				context?.projectId !== value?.projectId ||
				context?.dataset.id !== value?.dataset.id ||
				context?.dataset.currentVersionId !== value?.dataset.currentVersionId;
			const revisionChanged = context?.revision !== value?.revision;
			context = value;
			if (changed) {
				++scopeGeneration;
				++viewGeneration;
				++modelGeneration;
				++metadataGeneration;
				conversation = null;
				sessions = [];
				charts = [];
				executions = [];
				sending = false;
				loadingSessions = false;
				clearDraft();
				clearTranscript();
				input.value = "";
				credentialKey.value = "";
				if (value) {
					void loadModels();
					void loadConversations();
					void loadMetadata();
				}
			} else if (value && revisionChanged) void loadMetadata();
			renderContext();
			render();
		},
		dispose() {
			disposed = true;
			++viewGeneration;
			++scopeGeneration;
			++modelGeneration;
			++metadataGeneration;
			clearDraft();
			credentialKey.value = "";
		},
	};
}
