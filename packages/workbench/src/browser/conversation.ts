import {
	ASSISTANT_ATTACHMENT_FILE_BYTES,
	ASSISTANT_ATTACHMENT_MAX_FILES,
	ASSISTANT_ATTACHMENT_TOTAL_BYTES,
	type AssistantAttachment,
	type AssistantAttachmentInput,
	type AssistantContext,
	type AssistantExecutionReference,
} from "../assistant-contracts.ts";
import type { ChartFilter, ChartRecord } from "../chart-contracts.ts";
import { generateChartPython } from "../chart-spec.ts";
import type { Dataset } from "../contracts.ts";
import type {
	ChartProposal,
	Conversation,
	ConversationChartPreview,
	ConversationChartSaved,
	ConversationEvent,
	RenameProposal,
} from "../conversation-contracts.ts";
import {
	CONVERSATION_SCREENSHOT_FILE_BYTES,
	CONVERSATION_SCREENSHOT_MAX_FILES,
	CONVERSATION_SCREENSHOT_TOTAL_BYTES,
	type ConversationScreenshotInput,
} from "../conversation-contracts.ts";
import type { DatasetProfile } from "../profile-contracts.ts";
import type { ProviderModel, SessionModelSelection, SessionModelState } from "../provider-contracts.ts";
import type { TransformHistory } from "../transform-contracts.ts";
import { renderChart } from "./chart-renderer.ts";
import { renderMessageContent } from "./message-content.ts";
import { createProviders } from "./providers.ts";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS, matchesAppKeybinding } from "./shell.ts";

export interface ConversationUiContext {
	projectId: string;
	dataset: Dataset;
	profile: DatasetProfile | null;
	selectedColumns: number[];
	filters: ChartFilter[];
	revision: number;
	datasets?: Pick<Dataset, "id" | "name">[];
}

interface ConversationOptions {
	api<T>(path: string, options?: RequestInit): Promise<T>;
	stream(path: string, message: string, onEvent: (event: ConversationEvent) => void): Promise<Conversation>;
	message(error: unknown): string;
	onChanged(dataset: Dataset): Promise<void> | void;
	onChartSaved(chart: ChartRecord): Promise<void> | void;
	keybindings?: Partial<AppKeybindings>;
	onDatasetSelected?(id: string): Promise<void> | void;
}

export interface ConversationController {
	initialize(): Promise<void>;
	update(context: ConversationUiContext | null): void;
	dispose(): void;
}

type DraftAttachment = AssistantAttachmentInput & { byteLength: number };

const AGENT_ROLES = [
	{
		id: "analyst",
		label: "Pi Analyst",
		instructions:
			"Act as Pi Analyst. Analyze the shared evidence, explain findings and uncertainty, and suggest useful next steps. Respect the active mode and required exact-operation approvals.",
	},
	{
		id: "reviewer",
		label: "Pi Reviewer",
		instructions:
			"Act as Pi Reviewer. Critically review the requested analysis or proposal: check assumptions, data quality, methodology and risks. Distinguish evidence from inference and explain needed corrections. Respect the active mode and required exact-operation approvals.",
	},
] as const;

export function exportConversation(value: Conversation, format: "json" | "markdown"): string {
	const context = value.scope.context;
	const exported = {
		id: value.id,
		title: value.title,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		mode: value.mode ?? "execute",
		reasoningEffort: value.modelState?.thinkingLevel ?? value.reasoningEffort ?? "off",
		modelState: value.modelState,
		state: value.state,
		scope: {
			projectId: value.scope.projectId,
			datasetId: value.scope.datasetId,
			datasetVersionId: value.scope.datasetVersionId,
			provider: value.scope.provider,
			modelId: value.scope.modelId,
			contextHash: value.scope.contextHash,
			grantedAt: value.scope.grantedAt,
			context: {
				...context,
				attachedFiles: context.attachedFiles?.map(({ name, mediaType, byteLength, sha256 }) => ({
					name,
					mediaType,
					byteLength,
					sha256,
				})),
			},
			screenshots: value.scope.screenshots?.map(({ name, mediaType, byteLength, sha256 }) => ({
				name,
				mediaType,
				byteLength,
				sha256,
			})),
		},
		messages: value.messages.map(({ id, role, text, createdAt, state, model }) => ({ id, role, text, createdAt, state, model })),
		usage: value.usage,
	};
	if (format === "json") return JSON.stringify(exported, null, 2);
	return [
		`# ${value.title.replaceAll("\n", " ")}`,
		"",
		`Dataset: ${context.dataset.name} (${value.scope.datasetVersionId})`,
		`Original disclosure: ${value.scope.provider} / ${value.scope.modelId}`,
		`Selected model: ${value.modelState?.model ? `${value.modelState.model.name} (${value.modelState.model.provider} / ${value.modelState.model.id})` : "None"}${value.modelState?.routedModel ? ` → ${value.modelState.routedModel.name} (${value.modelState.routedModel.provider} / ${value.modelState.routedModel.id})` : ""}`,
		`Mode: ${exported.mode} · reasoning: ${exported.reasoningEffort}`,
		`Usage: ${value.usage.totalTokens} tokens`,
		"",
		"Attachment contents and image bytes are excluded from exports.",
		"",
		...value.messages.flatMap((message) => [
			`## ${message.role === "user" ? "You" : "Pi"} · ${message.createdAt}`,
			...(message.model ? [`Model: ${message.model.name} (${message.model.provider} / ${message.model.id})`] : []),
			"",
			message.text,
			"",
		]),
	].join("\n");
}

export function initializeConversation(container: HTMLElement, options: ConversationOptions): ConversationController {
	const document = container.ownerDocument;
	const keybindings = { ...DEFAULT_APP_KEYBINDINGS, ...options.keybindings };
	const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
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
	let mode: "plan" | "execute" = "execute";
	let draftModelState: SessionModelState | null = null;
	let availableModels: ProviderModel[] = [];
	let modelStateGeneration = 0;
	let loadingModel = false;
	let modelStateReady = false;
	let settingsSaving = false;
	let sessionSaving = false;
	let sessionRevision = 0;
	let sessionRenderKey = "";
	let transcriptRenderKey = "";
	let renderedMessages: Conversation["messages"] | undefined;
	let activityRenderKey = "";
	let lastRequest = "";
	let localNotice = "";
	let screenshots: (ConversationScreenshotInput & { byteLength: number })[] = [];
	const sessionGrants = new Set<string>();
	let suggestionIndex = 0;
	let proposals: RenameProposal[] = [];
	let loadingProposals = false;
	let proposalError = "";
	let proposalGeneration = 0;
	let proposalRevision = 0;
	let proposalRenderKey = "";
	let proposalExpiryTimer: number | undefined;
	const approvals = new Map<string, string>();
	const proposalActions = new Map<string, { id: string; action: "preview" | "apply" | "reject" }>();
	let chartProposals: ChartProposal[] = [];
	let loadingChartProposals = false;
	let chartProposalError = "";
	let chartProposalGeneration = 0;
	let chartProposalRevision = 0;
	let chartProposalRenderKey = "";
	let chartProposalExpiryTimer: number | undefined;
	const chartApprovals = new Map<string, string>();
	const chartProposalActions = new Map<string, { id: string; action: "preview" | "save" | "reject" }>();
	const chartPreviews = new Map<string, { previewId: string; canvas: HTMLElement; python: string }>();

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
	const heading = node("h2", "New session");
	const disclosure = node(
		"p",
		"Chat shares dataset metadata and your messages with the chosen provider, never automatic row samples. Pi can propose column renames and charts; it cannot execute or save them directly. You must preview and approve locally before a rename is applied or a chart is saved. Optional files are shared only after your consent and Send; they are never executed.",
		"muted",
	);
	const messages = node("div", undefined, "assistant-history");
	const sessionList = node("ul", undefined, "chat-session-list");
	const newSession = node("button", "New session", "button");
	newSession.id = "conversation-new";
	newSession.type = "button";
	const sidebar = node("aside", undefined, "chat-session-sidebar");
	const sessionSearch = node("input");
	sessionSearch.id = "conversation-search";
	sessionSearch.type = "search";
	sessionSearch.placeholder = "Search sessions";
	sessionSearch.setAttribute("aria-label", "Search saved sessions");
	sidebar.append(node("h3", "Sessions"), newSession, sessionSearch, sessionList);
	messages.setAttribute("aria-live", "polite");
	messages.setAttribute("role", "log");
	const proposalPanel = node("section", undefined, "chat-proposals");
	proposalPanel.id = "conversation-proposals";
	proposalPanel.setAttribute("aria-label", "Column rename proposals");
	const proposalHeading = node("h3", "Column rename proposals");
	const reloadProposals = node("button", "Reload proposals", "button");
	reloadProposals.id = "conversation-reload-proposals";
	reloadProposals.type = "button";
	const proposalStatus = node("p", undefined, "muted");
	proposalStatus.setAttribute("role", "status");
	const proposalCards = node("div", undefined, "chat-proposal-list");
	proposalPanel.append(proposalHeading, reloadProposals, proposalStatus, proposalCards);
	const chartProposalPanel = node("section", undefined, "chat-proposals");
	chartProposalPanel.id = "conversation-chart-proposals";
	chartProposalPanel.setAttribute("aria-label", "Chart proposals");
	const reloadChartProposals = node("button", "Reload chart proposals", "button");
	reloadChartProposals.id = "conversation-reload-chart-proposals";
	reloadChartProposals.type = "button";
	const chartProposalStatus = node("p", undefined, "muted");
	chartProposalStatus.setAttribute("role", "status");
	const chartProposalCards = node("div", undefined, "chat-proposal-list");
	chartProposalPanel.append(
		node("h3", "Chart proposals"),
		reloadChartProposals,
		chartProposalStatus,
		chartProposalCards,
	);
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
	fileInput.accept = ".py,.sql,.txt,.md,.json,image/png,image/jpeg,image/webp";
	const fileLabel = node("label", "Attach text files or images");
	fileLabel.htmlFor = fileInput.id;
	const fileHelp = node(
		"p",
		`UTF-8 .py, .sql, .txt, .md, .json: up to ${ASSISTANT_ATTACHMENT_MAX_FILES} files, ${ASSISTANT_ATTACHMENT_FILE_BYTES / 1024} KiB each, ${ASSISTANT_ATTACHMENT_TOTAL_BYTES / 1024} KiB total. PNG, JPEG or WebP: 4 images, 2 MiB each, 4 MiB total. Inspect and consent before sharing.`,
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
	const provider = node("button", "Manage providers", "button");
	provider.id = "conversation-provider";
	provider.type = "button";
	const model = node("button", "Choose a model", "button");
	model.id = "conversation-model";
	model.type = "button";
	model.setAttribute("aria-haspopup", "dialog");
	model.setAttribute("aria-label", "Choose Pi model");
	const controls = node("div", undefined, "chart-control-grid");
	const recipientNote = node("p", undefined, "muted");
	controls.append(recipientNote);
	controls.append(provider);
	const modelField = node("div", undefined, "chart-control");
	modelField.append(model);
	const contextPanel = node("section", undefined, "chat-context-panel");
	contextPanel.id = "conversation-context-panel";
	contextPanel.hidden = true;
	contextPanel.setAttribute("aria-label", "Context and provider settings");
	const closeContext = node("button", "Close context", "button");
	closeContext.type = "button";
	contextPanel.append(closeContext, disclosure, scopeDetails, controls);
	const header = node("header", undefined, "chat-header");
	const headerTitle = node("div", undefined, "chat-header-title");
	const headerPath = node("p", undefined, "chat-dataset-path");
	headerPath.id = "conversation-path";
	headerTitle.append(heading, headerPath);
	const headerStatus = node("span", undefined, "chat-status");
	headerStatus.id = "conversation-status";
	const usage = node("span", undefined, "chat-usage");
	usage.id = "conversation-usage";
	const contextToggle = node("button", "Context & provider", "button");
	contextToggle.type = "button";
	contextToggle.id = "conversation-context-toggle";
	contextToggle.setAttribute("aria-controls", contextPanel.id);
	contextToggle.setAttribute("aria-expanded", "false");
	const exports = node("details", undefined, "chat-export");
	exports.append(node("summary", "Export"));
	for (const format of ["json", "markdown"] as const) {
		const button = node("button", format === "json" ? "Download JSON" : "Download Markdown", "button");
		button.type = "button";
		button.id = `conversation-export-${format}`;
		button.addEventListener("click", () => {
			if (conversation) downloadConversation(conversation, format);
		});
		exports.append(button);
	}
	exports.append(
		node("p", "Attachment contents and images are excluded; shared metadata and transcript are included.", "muted"),
	);
	header.append(headerTitle, headerStatus, usage, contextToggle, exports);
	const scroll = node("div", undefined, "chat-scroll");
	const activity = node("details", undefined, "chat-activity");
	activity.id = "conversation-activity";
	const activitySummary = node("summary", "Activity");
	const activityList = node("ol");
	activity.append(activitySummary, activityList);
	scroll.append(messages, proposalPanel, chartProposalPanel, activity);
	const modeSelect = node("select");
	modeSelect.id = "conversation-mode";
	for (const value of ["execute", "plan"] as const) {
		const choice = option(value);
		choice.textContent = value === "plan" ? "Plan · read only" : "Execute · approval required";
		modeSelect.append(choice);
	}
	modeSelect.setAttribute("aria-label", "Agent mode");
	const reasoning = node("select");
	reasoning.id = "conversation-reasoning";
	reasoning.setAttribute("aria-label", "Reasoning effort");
	const screenshotList = node("ul", undefined, "chat-file-list");
	screenshotList.id = "conversation-screenshots";
	const screenshotConsent = node("input");
	screenshotConsent.id = "conversation-screenshot-consent";
	screenshotConsent.type = "checkbox";
	const screenshotLabel = node("label", undefined, "assistant-check");
	screenshotLabel.append(
		screenshotConsent,
		node(
			"span",
			"I consent to save these images in this session and send them to the selected image-capable provider on Send. Inspect images for private information first.",
		),
	);
	scopeDetails.append(screenshotList, screenshotLabel);
	const form = node("form", undefined, "assistant-form");
	const input = node("textarea");
	input.id = "conversation-message";
	input.rows = 1;
	input.maxLength = 16 * 1024;
	input.placeholder = "Ask Pi to analyze, transform, visualize, or explain…";
	input.required = true;
	const inputLabel = node("label", "Message");
	inputLabel.htmlFor = input.id;
	const send = node("button", "↑", "button button-primary chat-send");
	send.setAttribute("aria-label", "Send message");
	send.title = "Send message";
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
	const composerTools = node("div", undefined, "chat-composer-tools");
	const attach = node("button", "+ Attach", "button");
	attach.type = "button";
	attach.id = "conversation-attach";
	const inspectContext = node("button", "Context", "button");
	inspectContext.type = "button";
	const dataLink = node("button", "Dataset", "button");
	dataLink.type = "button";
	const datasetSelect = node("select");
	datasetSelect.id = "conversation-dataset";
	datasetSelect.setAttribute("aria-label", "Current dataset");
	const agent = node("select");
	agent.id = "conversation-agent";
	agent.setAttribute("aria-label", "Agent prompt role");
	agent.title = "Prompt behavior only; does not change tools or permissions";
	for (const role of AGENT_ROLES) {
		const choice = option(role.id);
		choice.textContent = role.label;
		agent.append(choice);
	}
	const agentReview = node("details", undefined, "chat-agent-instructions");
	const agentInstructions = node("pre");
	agentInstructions.id = "conversation-agent-instructions";
	agentReview.append(
		node("summary", "Review message sent to Pi"),
		node(
			"p",
			"Role instructions are prepended to your message. They do not change tools, Plan mode or approvals.",
			"muted",
		),
		agentInstructions,
	);
	agent.setAttribute("aria-describedby", agentInstructions.id);
	composerTools.append(
		attach,
		inspectContext,
		datasetSelect,
		dataLink,
		agent,
		modelField,
		modeSelect,
		reasoning,
		actions,
	);
	const suggestions = node("div", undefined, "chat-suggestions");
	suggestions.id = "conversation-suggestions";
	suggestions.hidden = true;
	suggestions.setAttribute("role", "listbox");
	input.setAttribute("aria-controls", suggestions.id);
	input.setAttribute("aria-autocomplete", "list");
	const consentSummary = node(
		"p",
		"Metadata only · no automatic row samples · inspect Context before Send",
		"chat-consent-summary",
	);
	const modeNote = node("p", undefined, "chat-mode-note");
	modeNote.id = "conversation-mode-note";
	const keyHint = node("p", undefined, "chat-key-hint");
	keyHint.id = "conversation-key-hint";
	const describeBindings = (bindings: AppKeybindings["sendMessage"]): string =>
		bindings
			.map((binding) =>
				[
					...(binding.ctrl ? ["Ctrl"] : []),
					...(binding.meta ? ["Meta"] : []),
					...(binding.alt ? ["Alt"] : []),
					...(binding.shift ? ["Shift"] : []),
					binding.key === " " ? "Space" : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
				].join("+"),
			)
			.join(" / ");
	keyHint.textContent = [
		keybindings.sendMessage.length ? `${describeBindings(keybindings.sendMessage)} to send` : "Use Send to send",
		keybindings.newline.length
			? `${describeBindings(keybindings.newline)} for new line`
			: "New-line shortcut disabled",
	].join(" · ");
	input.setAttribute("aria-describedby", keyHint.id);
	form.append(inputLabel, input, suggestions, composerTools);
	const composer = node("div", undefined, "chat-composer-dock");
	composer.append(consentSummary, form, keyHint, agentReview, modeNote, feedback);
	const chatMain = node("section", undefined, "chat-transcript");
	chatMain.append(header, contextPanel, scroll, composer);
	const chatShell = node("div", undefined, "chat-shell");
	const sidebarHost = document.getElementById("session-sidebar-host");
	if (sidebarHost) {
		sidebarHost.replaceChildren(sidebar);
		chatShell.append(chatMain);
	} else chatShell.append(sidebar, chatMain);
	container.replaceChildren(chatShell);
	const existingProvidersRoot = document.getElementById("providers-root");
	const providersRoot = existingProvidersRoot ?? node("div");
	if (!existingProvidersRoot) document.body.append(providersRoot);
	const providers = createProviders({
		root: providersRoot,
		request: options.api,
		onModelsChanged: refreshModels,
		onSelectModel: selectModel,
		getModelState: loadModelState,
	});

	function openContext(): void {
		contextPanel.dataset.returnFocus = document.activeElement?.id ?? "conversation-context-toggle";
		contextPanel.hidden = false;
		contextToggle.setAttribute("aria-expanded", "true");
	}
	function hideContext(): void {
		contextPanel.hidden = true;
		contextToggle.setAttribute("aria-expanded", "false");
		(document.getElementById(contextPanel.dataset.returnFocus ?? "") ?? contextToggle).focus();
	}
	function navigate(destination: "chat" | "data" | "settings"): void {
		document.dispatchEvent(new document.defaultView!.CustomEvent("workbench:navigate", { detail: destination }));
	}
	function downloadConversation(value: Conversation, format: "json" | "markdown"): void {
		try {
			const blob = new Blob([exportConversation(value, format)], {
				type: format === "json" ? "application/json" : "text/markdown;charset=utf-8",
			});
			const url = URL.createObjectURL(blob);
			const link = node("a");
			link.href = url;
			link.download = `${value.title.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "session"}.${format === "json" ? "json" : "md"}`;
			document.body.append(link);
			link.click();
			link.remove();
			document.defaultView!.setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (error) {
			feedbackError = `Export failed: ${options.message(error)}`;
			render();
		}
	}
	function selectSession(value: Conversation | null): void {
		if (busy() || sessionSaving || settingsSaving || !context) return;
		++viewGeneration;
		providers.close();
		conversation = value ? structuredClone(value) : null;
		mode = conversation?.mode ?? "execute";
		loadingModel = true;
		sessionGrants.clear();
		clearProposals();
		clearDraft();
		clearTranscript();
		input.value = "";
		autosize();
		void refreshModelState();
		renderContext();
		render();
		if (conversation) {
			void loadProposals();
			void loadChartProposals();
		} else void loadMetadata();
	}
	async function changeSession(
		value: Conversation,
		action: "rename" | "duplicate" | "archive",
		title?: string,
	): Promise<void> {
		if (busy() || sessionSaving || !context) return;
		const owner = viewGeneration;
		const endpoint = `${datasetPath()}/conversations/${encodeURIComponent(value.id)}`;
		sessionSaving = true;
		feedbackError = "";
		render();
		try {
			const result = await options.api<Conversation>(action === "rename" ? endpoint : `${endpoint}/${action}`, {
				method: action === "rename" ? "PATCH" : "POST",
				...(action === "rename"
					? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }
					: {}),
			});
			if (!current(owner)) return;
			if (action === "archive") {
				sessions = sessions.filter((item) => item.id !== value.id);
				++sessionRevision;
				if (conversation?.id === value.id) {
					sessionSaving = false;
					selectSession(null);
				}
			} else {
				remember(result);
				if (action === "duplicate") {
					sessionSaving = false;
					selectSession(result);
				} else if (conversation?.id === value.id) conversation = result;
			}
		} catch (error) {
			if (current(owner)) feedbackError = options.message(error);
		} finally {
			if (current(owner)) {
				sessionSaving = false;
				render();
			} else if (!disposed) {
				sessionSaving = false;
				render();
			}
		}
	}
	function renderSessions(): void {
		const active = busy() || sessionSaving || settingsSaving;
		const key = `${sessionRevision}:${conversation?.id}:${context?.dataset.currentVersionId}:${active}:${sessionSearch.value}`;
		if (key === sessionRenderKey) return;
		sessionRenderKey = key;
		sessionList.replaceChildren();
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);
		let previousGroup = "";
		for (const item of sessions
			.filter(
				(item) =>
					!item.archivedAt && item.title.toLocaleLowerCase().includes(sessionSearch.value.toLocaleLowerCase()),
			)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
			const ageSeconds = (Date.parse(item.updatedAt) - Date.now()) / 1000;
			const [unit, seconds]: [Intl.RelativeTimeFormatUnit, number] =
				Math.abs(ageSeconds) >= 86400
					? ["day", 86400]
					: Math.abs(ageSeconds) >= 3600
						? ["hour", 3600]
						: Math.abs(ageSeconds) >= 60
							? ["minute", 60]
							: ["second", 1];
			const timestamp = Date.parse(item.updatedAt);
			const group =
				timestamp >= today.getTime() ? "Today" : timestamp >= yesterday.getTime() ? "Yesterday" : "Previous";
			if (group !== previousGroup) {
				sessionList.append(node("li", group, "chat-session-group"));
				previousGroup = group;
			}
			const entry = node("li", undefined, "chat-session-entry");
			entry.dataset.state = item.state;
			const select = node("button", item.title, "chat-session-select");
			select.type = "button";
			select.setAttribute("aria-current", String(item.id === conversation?.id));
			select.disabled = active || item.id === conversation?.id;
			select.addEventListener("click", () => selectSession(item));
			const meta = node(
				"span",
				`${item.state} · ${relativeTime.format(Math.round(ageSeconds / seconds), unit)}${item.scope.datasetVersionId !== context?.dataset.currentVersionId ? " · older version" : ""}`,
				"chat-session-meta",
			);
			meta.title = new Date(item.updatedAt).toLocaleString();
			const menu = node("details", undefined, "chat-session-menu");
			const summary = node("summary", "⋯");
			summary.setAttribute("aria-label", `Actions for ${item.title}`);
			menu.append(summary);
			const rename = node("button", "Rename", "button");
			rename.type = "button";
			const renameForm = node("form", undefined, "chat-session-rename");
			renameForm.hidden = true;
			const name = node("input");
			name.value = item.title;
			name.required = true;
			name.maxLength = 160;
			name.setAttribute("aria-label", "Session title");
			const save = node("button", "Save title", "button");
			save.type = "submit";
			renameForm.append(name, save);
			rename.addEventListener("click", () => {
				renameForm.hidden = false;
				name.focus();
				name.select();
			});
			renameForm.addEventListener("submit", (event) => {
				event.preventDefault();
				if (name.value.trim()) void changeSession(item, "rename", name.value.trim());
			});
			const duplicate = node("button", "Duplicate", "button");
			duplicate.type = "button";
			duplicate.addEventListener("click", () => {
				void changeSession(item, "duplicate");
			});
			const exportJson = node("button", "Export JSON", "button");
			exportJson.type = "button";
			exportJson.addEventListener("click", () => downloadConversation(item, "json"));
			const exportMarkdown = node("button", "Export Markdown", "button");
			exportMarkdown.type = "button";
			exportMarkdown.addEventListener("click", () => downloadConversation(item, "markdown"));
			const remove = node("button", "Delete…", "button");
			remove.type = "button";
			const confirmation = node("div", undefined, "chat-session-confirm");
			confirmation.hidden = true;
			confirmation.append(node("p", "Remove this session from the list? Local audit records are retained."));
			const confirm = node("button", "Delete session", "button");
			confirm.type = "button";
			const keep = node("button", "Keep session", "button");
			keep.type = "button";
			confirm.addEventListener("click", () => {
				void changeSession(item, "archive");
			});
			keep.addEventListener("click", () => {
				confirmation.hidden = true;
			});
			remove.addEventListener("click", () => {
				confirmation.hidden = false;
				confirm.focus();
			});
			confirmation.append(confirm, keep);
			menu.append(rename, renameForm, duplicate, exportJson, exportMarkdown, remove, confirmation);
			for (const button of menu.querySelectorAll("button")) button.disabled = active;
			entry.append(select, meta, menu);
			sessionList.append(entry);
		}
		if (!previousGroup)
			sessionList.append(
				node("li", sessionSearch.value ? "No matching sessions" : "No saved sessions yet", "muted"),
			);
	}
	async function saveSettings(): Promise<void> {
		if (busy() || settingsSaving || proposalActionBusy()) return;
		const nextMode = modeSelect.value as "plan" | "execute";
		sessionGrants.clear();
		invalidateApproval();
		if (!conversation) {
			mode = nextMode;
			render();
			return;
		}
		const owner = viewGeneration;
		settingsSaving = true;
		feedbackError = "";
		render();
		try {
			const value = await options.api<Conversation>(
				`${datasetPath()}/conversations/${encodeURIComponent(conversation.id)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ mode: nextMode }),
				},
			);
			if (!current(owner)) return;
			conversation = value;
			remember(value);
			mode = value.mode ?? "execute";
		} catch (error) {
			if (current(owner)) feedbackError = options.message(error);
		} finally {
			if (current(owner)) {
				settingsSaving = false;
				invalidateApproval();
				render();
			}
		}
	}

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
		++sessionRevision;
	}
	function clearDraft(): void {
		attachments = [];
		screenshots = [];
		screenshotConsent.checked = false;
		executionIds = new Set();
		fileConsent.checked = false;
		fileInput.value = "";
		readingFiles = false;
	}
	function clearTranscript(): void {
		partial = "";
		optimisticMessage = null;
		agent.value = "analyst";
		streamStatus = "";
		suggestions.hidden = true;
		input.removeAttribute("aria-activedescendant");
		input.setAttribute("aria-expanded", "false");
		feedbackError = "";
		lastRequest = "";
		localNotice = "";
	}
	function staleConversation(): boolean {
		return !!conversation && conversation.scope.datasetVersionId !== context?.dataset.currentVersionId;
	}
	function proposalPath(): string {
		if (!conversation) throw new Error("Choose a chat to review its proposals.");
		return `${datasetPath()}/conversations/${encodeURIComponent(conversation.id)}/proposals`;
	}
	function invalidateApproval(): void {
		approvals.clear();
		++proposalRevision;
		chartApprovals.clear();
		++chartProposalRevision;
	}
	function clearProposals(): void {
		clearChartProposals();
		++proposalGeneration;
		proposals = [];
		proposalError = "";
		loadingProposals = false;
		invalidateApproval();
	}
	async function loadProposals(): Promise<void> {
		if (!context || !conversation) return;
		const owner = ++proposalGeneration;
		const view = viewGeneration;
		const endpoint = proposalPath();
		loadingProposals = true;
		proposalError = "";
		invalidateApproval();
		render();
		try {
			const values = await options.api<RenameProposal[]>(endpoint);
			if (!current(view) || owner !== proposalGeneration) return;
			proposals = values;
		} catch (error) {
			if (current(view) && owner === proposalGeneration) proposalError = options.message(error);
		} finally {
			if (current(view) && owner === proposalGeneration) {
				loadingProposals = false;
				invalidateApproval();
				render();
			}
		}
	}
	function validPreview(proposal: RenameProposal): boolean {
		return (
			proposal.state === "previewed" && !!proposal.preview && Date.parse(proposal.preview.expiresAt) > Date.now()
		);
	}
	async function actOnProposal(id: string, action: "preview" | "apply" | "reject"): Promise<void> {
		if (!context || !conversation || busy() || loadingProposals || proposalActionBusy()) return;
		if (settingsSaving || (mode === "plan" && action !== "reject")) return;
		const proposal = proposals.find((item) => item.id === id);
		const endpoint = proposalPath();
		if (!proposal || proposalActions.has(endpoint)) return;
		if (action === "reject") {
			if (["applied", "rejected", "previewing", "applying"].includes(proposal.state)) return;
		} else if (
			staleConversation() ||
			proposal.inputVersionId !== context.dataset.currentVersionId ||
			!["proposed", "previewed", "failed"].includes(proposal.state)
		)
			return;
		const previewId = proposal.preview?.id;
		if (action === "apply" && (!validPreview(proposal) || approvals.get(id) !== previewId)) return;
		const owner = ++proposalGeneration;
		const view = viewGeneration;
		const request = { id, action };
		let reloadAfterAction = false;
		proposalActions.set(endpoint, request);
		proposalError = "";
		invalidateApproval();
		render();
		try {
			const result = await options.api<RenameProposal | { proposal: RenameProposal; dataset: Dataset }>(
				`${endpoint}/${encodeURIComponent(id)}/${action}`,
				{
					method: "POST",
					...(action === "apply"
						? {
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ previewId, approved: true }),
							}
						: {}),
				},
			);
			if (!current(view) || owner !== proposalGeneration) {
				reloadAfterAction = true;
				return;
			}
			const updated = "proposal" in result ? result.proposal : result;
			proposals = proposals.map((item) => (item.id === id ? updated : item));
			invalidateApproval();
			render();
			if ("dataset" in result) {
				context = { ...context, dataset: result.dataset };
				renderContext();
				render();
				await options.onChanged(result.dataset);
			}
		} catch (error) {
			if (current(view) && owner === proposalGeneration) {
				await loadProposals();
				if (current(view) && owner + 1 === proposalGeneration) proposalError = options.message(error);
			} else reloadAfterAction = true;
		} finally {
			if (proposalActions.get(endpoint) === request) proposalActions.delete(endpoint);
			if (!disposed) {
				++proposalRevision;
				render();
				if (reloadAfterAction && context && conversation && proposalPath() === endpoint) void loadProposals();
			}
		}
	}
	function renderProposals(): void {
		const pending = conversation && context ? proposalActions.get(proposalPath()) : undefined;
		const key = `${proposalRevision}:${busy()}:${mode}:${settingsSaving}:${pending?.id}:${pending?.action}:${proposalActionBusy()}`;
		if (key === proposalRenderKey) return;
		proposalRenderKey = key;
		document.defaultView!.clearTimeout(proposalExpiryTimer);
		proposalPanel.hidden = !conversation || (!proposals.length && !loadingProposals && !pending && !proposalError);
		proposalPanel.setAttribute("aria-busy", String(loadingProposals || !!pending));
		reloadProposals.disabled = !conversation || busy() || loadingProposals || proposalActionBusy();
		proposalStatus.textContent =
			proposalError ||
			(loadingProposals
				? "Loading proposals…"
				: pending
					? `${pending.action === "apply" ? "Applying" : pending.action === "preview" ? "Previewing" : "Rejecting"} rename…`
					: proposals.length
						? "Preview and approval are local. No preview data, SQL or cell rows are sent to Pi or your provider."
						: "No column renames proposed in this chat.");
		proposalStatus.className = proposalError ? "inline-error" : "muted";
		const focused = document.activeElement?.id;
		const openDetails = new Set(
			[...proposalCards.querySelectorAll<HTMLDetailsElement>("details[open]")].map((item) => item.id),
		);
		proposalCards.replaceChildren();
		let expiresAt = Infinity;
		for (const proposal of proposals) {
			const card = node("article", undefined, "chat-proposal");
			const prefix = `conversation-proposal-${encodeURIComponent(proposal.id)}`;
			card.dataset.proposalId = proposal.id;
			card.dataset.status = proposal.state;
			card.setAttribute("aria-labelledby", `${prefix}-heading`);
			const title = node("h4", `Rename ${proposal.oldName} → ${proposal.name}`);
			title.id = `${prefix}-heading`;
			card.append(
				title,
				node("p", `Input version: ${proposal.inputVersionId}`, "chat-file-hash"),
				node("p", `Status: ${proposal.state}`, "state-label"),
			);
			if (proposal.outputVersionId)
				card.append(node("p", `Output version: ${proposal.outputVersionId}`, "chat-file-hash"));
			if (proposal.error) card.append(node("p", proposal.error, "inline-error"));
			const stale =
				staleConversation() ||
				proposal.inputVersionId !== context?.dataset.currentVersionId ||
				proposal.state === "stale";
			if (stale && proposal.state !== "applied" && proposal.state !== "rejected")
				card.append(
					node(
						"p",
						"This proposal is for a stale dataset version. Start a New chat to propose a rename for the current version. You can still reject this proposal.",
						"muted",
					),
				);
			if (proposal.state === "applied")
				card.append(
					node(
						"p",
						"Rename applied locally. Use Transform history to undo. Start a New chat to use the updated dataset.",
						"muted",
					),
				);
			if (proposal.preview) {
				const preview = proposal.preview;
				card.append(
					node(
						"p",
						"Local preview only. No data or SQL is sent to Pi or the provider. No cell rows are shown.",
						"muted",
					),
				);
				card.append(
					node(
						"p",
						`Input rows: ${preview.inputRows} · Output rows: ${preview.outputRows} · Affected rows: ${preview.affectedRows}`,
					),
				);
				const sql = node("details");
				sql.id = `${prefix}-sql`;
				sql.open = openDetails.has(sql.id);
				sql.append(node("summary", "Inspect local preview SQL"), node("pre", preview.sql, "assistant-exact"));
				card.append(sql, node("p", `Preview: ${preview.id} · expires ${preview.expiresAt}`, "chat-file-hash"));
				if (proposal.state === "previewed") {
					if (validPreview(proposal)) expiresAt = Math.min(expiresAt, Date.parse(preview.expiresAt));
					else card.append(node("p", "This preview has expired. Preview again before approving.", "muted"));
				}
			}
			const audit = node("details");
			audit.id = `${prefix}-audit`;
			audit.open = openDetails.has(audit.id);
			audit.append(node("summary", "Audit timeline"));
			const timeline = node("ol");
			for (const event of proposal.audit)
				timeline.append(node("li", `${event.at} · ${event.actor} · ${event.action.replaceAll("_", " ")}`));
			audit.append(timeline);
			card.append(audit);
			const blocked = busy() || loadingProposals || proposalActionBusy();
			const preview = node("button", "Preview", "button");
			preview.id = `${prefix}-preview`;
			preview.type = "button";
			preview.disabled =
				blocked ||
				settingsSaving ||
				mode === "plan" ||
				stale ||
				!["proposed", "previewed", "failed"].includes(proposal.state);
			preview.addEventListener("click", () => {
				void actOnProposal(proposal.id, "preview");
			});
			const approve = node("input");
			approve.id = `${prefix}-approve`;
			approve.type = "checkbox";
			approve.checked = approvals.get(proposal.id) === proposal.preview?.id && !!proposal.preview;
			approve.disabled = blocked || settingsSaving || mode === "plan" || stale || !validPreview(proposal);
			const label = node("label", undefined, "assistant-check");
			label.append(
				approve,
				node(
					"span",
					proposal.preview
						? `I approve this exact preview (${proposal.preview.id}) to rename ${proposal.oldName} to ${proposal.name} on version ${proposal.inputVersionId}.`
						: "Preview this rename before approving it.",
				),
			);
			const apply = node("button", "Allow once · apply", "button button-primary");
			apply.id = `${prefix}-apply`;
			apply.type = "button";
			apply.disabled = approve.disabled || !approve.checked;
			approve.addEventListener("change", () => {
				if (approve.disabled || !validPreview(proposal)) return;
				if (approve.checked) approvals.set(proposal.id, proposal.preview!.id);
				else {
					approvals.delete(proposal.id);
					sessionGrants.delete(grant);
				}
				apply.disabled = !approve.checked;
			});
			apply.addEventListener("click", () => {
				void actOnProposal(proposal.id, "apply");
			});
			const reject = node("button", "Deny", "button");
			reject.id = `${prefix}-reject`;
			reject.type = "button";
			reject.disabled = blocked || ["applied", "rejected", "previewing", "applying"].includes(proposal.state);
			reject.addEventListener("click", () => {
				void actOnProposal(proposal.id, "reject");
			});
			const controls = node("div", undefined, "chat-proposal-actions");
			const always = node("button", "Always allow this session", "button");
			always.type = "button";
			always.id = `${prefix}-always`;
			always.title =
				"Remember approval only for this exact preview, version and operation in this session. New or expired previews always need approval. Does not apply until you choose Allow once · apply.";
			always.disabled = approve.disabled;
			const grant = JSON.stringify([
				conversation?.id,
				"rename",
				proposal.id,
				proposal.inputVersionId,
				proposal.column,
				proposal.oldName,
				proposal.name,
				proposal.preview,
			]);
			if (!approve.disabled && sessionGrants.has(grant)) {
				approve.checked = true;
				approvals.set(proposal.id, proposal.preview!.id);
				apply.disabled = false;
			}
			always.addEventListener("click", () => {
				if (approve.disabled || !validPreview(proposal)) return;
				sessionGrants.add(grant);
				approvals.set(proposal.id, proposal.preview!.id);
				approve.checked = true;
				apply.disabled = false;
				localNotice =
					"Approval remembered for this exact preview only. Choose apply to execute; other operations still need approval.";
				renderComposer();
			});
			controls.append(preview, apply, always, reject);
			card.append(label, controls);
			proposalCards.append(card);
		}
		if (focused) document.getElementById(focused)?.focus();
		if (Number.isFinite(expiresAt))
			proposalExpiryTimer = document.defaultView!.setTimeout(
				() => {
					invalidateApproval();
					render();
				},
				Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now())),
			);
	}
	function chartProposalPath(): string {
		if (!conversation) throw new Error("Choose a chat to review its chart proposals.");
		return `${datasetPath()}/conversations/${encodeURIComponent(conversation.id)}/chart-proposals`;
	}
	function proposalActionBusy(): boolean {
		return !!(
			context &&
			conversation &&
			(proposalActions.has(proposalPath()) || chartProposalActions.has(chartProposalPath()))
		);
	}
	function invalidateChartApproval(): void {
		chartApprovals.clear();
		++chartProposalRevision;
	}
	function clearChartProposals(): void {
		++chartProposalGeneration;
		chartProposals = [];
		chartProposalError = "";
		loadingChartProposals = false;
		chartPreviews.clear();
		invalidateChartApproval();
	}
	async function loadChartProposals(): Promise<void> {
		if (!context || !conversation) return;
		const owner = ++chartProposalGeneration;
		const view = viewGeneration;
		const endpoint = chartProposalPath();
		loadingChartProposals = true;
		chartProposalError = "";
		chartPreviews.clear();
		invalidateChartApproval();
		render();
		try {
			const values = await options.api<ChartProposal[]>(endpoint);
			if (!current(view) || owner !== chartProposalGeneration) return;
			chartProposals = values;
		} catch (error) {
			if (current(view) && owner === chartProposalGeneration) chartProposalError = options.message(error);
		} finally {
			if (current(view) && owner === chartProposalGeneration) {
				loadingChartProposals = false;
				invalidateChartApproval();
				render();
			}
		}
	}
	function validChartPreview(proposal: ChartProposal): boolean {
		return (
			proposal.state === "previewed" && !!proposal.preview && Date.parse(proposal.preview.expiresAt) > Date.now()
		);
	}
	function renderedChartPreview(proposal: ChartProposal): boolean {
		return validChartPreview(proposal) && chartPreviews.get(proposal.id)?.previewId === proposal.preview!.id;
	}
	async function actOnChartProposal(id: string, action: "preview" | "save" | "reject"): Promise<void> {
		if (!context || !conversation || busy() || loadingChartProposals || proposalActionBusy()) return;
		if (settingsSaving || (mode === "plan" && action !== "reject")) return;
		const proposal = chartProposals.find((item) => item.id === id);
		if (!proposal) return;
		if (action === "reject") {
			if (["saved", "rejected", "previewing"].includes(proposal.state)) return;
		} else if (
			staleConversation() ||
			proposal.inputVersionId !== context.dataset.currentVersionId ||
			!["proposed", "previewed", "failed"].includes(proposal.state)
		)
			return;
		const previewId = proposal.preview?.id;
		if (action === "save" && (!renderedChartPreview(proposal) || chartApprovals.get(id) !== previewId)) return;
		const endpoint = chartProposalPath();
		const owner = ++chartProposalGeneration;
		const view = viewGeneration;
		const focused = document.activeElement?.id;
		const request = { id, action };
		let reloadAfterAction = false;
		chartProposalActions.set(endpoint, request);
		chartProposalError = "";
		if (action === "preview") chartPreviews.delete(id);
		invalidateApproval();
		render();
		try {
			const result = await options.api<ChartProposal | ConversationChartPreview | ConversationChartSaved>(
				`${endpoint}/${encodeURIComponent(id)}/${action}`,
				{
					method: "POST",
					...(action === "save"
						? {
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ previewId, approved: true }),
							}
						: {}),
				},
			);
			if (
				!disposed &&
				"chart" in result &&
				"id" in result.chart &&
				context?.projectId === result.chart.projectId &&
				context.dataset.id === result.chart.datasetId
			)
				await options.onChartSaved(result.chart);
			if (!current(view) || owner !== chartProposalGeneration) {
				reloadAfterAction = true;
				return;
			}
			const updated = "proposal" in result ? result.proposal : result;
			chartProposals = chartProposals.map((item) => (item.id === id ? updated : item));
			if ("chart" in result && "marks" in result.chart && updated.preview) {
				const chart = result.chart;
				const canvas = node("div", undefined, "chart-canvas chat-chart-canvas");
				canvas.id = `conversation-chart-proposal-${encodeURIComponent(id)}-canvas`;
				renderChart(canvas, chart);
				const metadata = node("dl", undefined, "chat-chart-metadata");
				const facts: [string, string][] = [
					[
						"Sample",
						`${chart.sampleSize} / ${chart.populationRows} rows · ${chart.sampled ? "sampled, not population estimates" : "all rows"} · stride ${chart.stride} · byte cap ${chart.byteLimited ? "reached" : "not reached"}`,
					],
					["Filters", `${chart.labels.filters || "none"} · ${chart.filteredRows} rows remain`],
					["Aggregation", chart.labels.aggregation],
					["Missing / invalid values", `${chart.labels.missing} · ${chart.excludedRows} excluded rows`],
					["Display", `${chart.marks.length} marks · ${chart.omittedMarks} omitted marks`],
					[
						"Encodings",
						`X: ${chart.labels.x}; Y: ${chart.labels.y}; color: ${chart.labels.color}; size: ${chart.labels.size}; facet: ${chart.labels.facet}`,
					],
					["Provenance", `${chart.spec.datasetVersionId} · ${chart.datasetVersionHash} · ${chart.generatedAt}`],
				];
				for (const [label, value] of facts) metadata.append(node("dt", label), node("dd", value));
				const warnings = node("ul", undefined, "chat-chart-warnings");
				warnings.setAttribute("aria-label", "Chart warnings");
				for (const warning of chart.warnings) warnings.append(node("li", warning));
				canvas.append(metadata, warnings);
				chartPreviews.set(id, { previewId: updated.preview.id, canvas, python: generateChartPython(chart) });
			}
			if (action === "reject") chartPreviews.delete(id);
			invalidateChartApproval();
			render();
		} catch (error) {
			if (current(view) && owner === chartProposalGeneration) {
				await loadChartProposals();
				if (current(view) && owner + 1 === chartProposalGeneration) chartProposalError = options.message(error);
			} else reloadAfterAction = true;
		} finally {
			if (chartProposalActions.get(endpoint) === request) chartProposalActions.delete(endpoint);
			if (!disposed) {
				++chartProposalRevision;
				render();
				if (
					current(view) &&
					owner === chartProposalGeneration &&
					focused &&
					document.activeElement === document.body
				)
					document.getElementById(focused)?.focus();
				if (reloadAfterAction && context && conversation && chartProposalPath() === endpoint)
					void loadChartProposals();
			}
		}
	}
	function renderChartProposals(): void {
		const pending = context && conversation ? chartProposalActions.get(chartProposalPath()) : undefined;
		const key = `${chartProposalRevision}:${busy()}:${mode}:${settingsSaving}:${pending?.id}:${pending?.action}:${proposalActionBusy()}`;
		if (key === chartProposalRenderKey) return;
		chartProposalRenderKey = key;
		document.defaultView!.clearTimeout(chartProposalExpiryTimer);
		chartProposalPanel.hidden =
			!conversation || (!chartProposals.length && !loadingChartProposals && !pending && !chartProposalError);
		chartProposalPanel.setAttribute("aria-busy", String(loadingChartProposals || !!pending));
		reloadChartProposals.disabled = !conversation || busy() || loadingChartProposals || proposalActionBusy();
		chartProposalStatus.textContent =
			chartProposalError ||
			(loadingChartProposals
				? "Loading chart proposals…"
				: pending
					? `${pending.action === "save" ? "Saving" : pending.action === "preview" ? "Previewing" : "Rejecting"} chart…`
					: chartProposals.length
						? "Preview and approval are local. No chart result, preview rows or generated code are sent to Pi or your provider. Saving creates a chart in Visualize, not a dataset version."
						: "No charts proposed in this chat.");
		chartProposalStatus.className = chartProposalError ? "inline-error" : "muted";
		const focused = document.activeElement?.id;
		const openDetails = new Set(
			[...chartProposalCards.querySelectorAll<HTMLDetailsElement>("details[open]")].map((item) => item.id),
		);
		const previousPreviews = new Map(
			[...chartProposalCards.querySelectorAll<HTMLElement>("[data-preview-id]")].map((item) => [
				item.id,
				item.dataset.previewId,
			]),
		);
		chartProposalCards.replaceChildren();
		let expiresAt = Infinity;
		const frozen = conversation?.scope.context;
		const columnName = (index: number) =>
			frozen?.schema.find((column) => column.index === index)?.name ?? `#${index}`;
		for (const proposal of chartProposals) {
			const card = node("article", undefined, "chat-proposal chat-chart-proposal");
			const prefix = `conversation-chart-proposal-${encodeURIComponent(proposal.id)}`;
			card.dataset.proposalId = proposal.id;
			card.dataset.status = proposal.state;
			card.setAttribute("aria-labelledby", `${prefix}-heading`);
			const title = node("h4", proposal.title);
			title.id = `${prefix}-heading`;
			card.append(
				title,
				node("p", proposal.explanation),
				node("p", `Affected fields: ${proposal.affectedColumns.map(columnName).join(", ") || "none"}`),
				node("p", `Confidence: ${Math.round(proposal.confidence * 100)}% · Basis: ${proposal.basis}`),
				node(
					"p",
					proposal.basis === "hypothesis"
						? "Hypothesis: no supporting frozen metrics were cited. This is an unverified inference, not a finding; inspect the local preview."
						: "Evidence-linked inference: cited metrics support a suggestion, not proof of a relationship or causation. Inspect the local preview.",
					"muted",
				),
				node("p", `Input version: ${proposal.inputVersionId}`, "chat-file-hash"),
				node("p", `Status: ${proposal.state}`, "state-label"),
			);
			const evidence = node("ul", undefined, "chat-chart-evidence");
			evidence.setAttribute("aria-label", "Frozen evidence");
			for (const ref of proposal.evidenceRefs) {
				const metric = frozen?.evidence.find((item) => item.id === ref);
				evidence.append(
					node(
						"li",
						metric
							? `${ref} · ${metric.metric}: ${metric.value ?? "unavailable"} · ${metric.columns.map(columnName).join(", ") || "dataset"} · ${metric.basis === "full" ? "full data" : "sample"} · ${metric.rows} rows · ${metric.approximate ? "approximate" : "not approximate"}`
							: `${ref} · metric unavailable in this frozen context`,
					),
				);
			}
			if (proposal.evidenceRefs.length) card.append(evidence);
			const spec = node("details");
			spec.id = `${prefix}-spec`;
			spec.open = openDetails.has(spec.id);
			const json = node("pre", JSON.stringify(proposal.spec, null, 2), "assistant-exact");
			json.tabIndex = 0;
			spec.append(node("summary", "Inspect chart specification JSON"), json);
			card.append(spec);
			if (proposal.error) card.append(node("p", proposal.error, "inline-error"));
			const stale =
				staleConversation() ||
				proposal.inputVersionId !== context?.dataset.currentVersionId ||
				proposal.state === "stale";
			if (stale && !["saved", "rejected"].includes(proposal.state))
				card.append(
					node(
						"p",
						"This proposal is for a stale dataset version. Start a New chat to propose a chart for the current version. You can still reject this proposal.",
						"muted",
					),
				);
			if (proposal.state === "saved")
				card.append(
					node(
						"p",
						`Chart saved locally: ${proposal.chartId}. Open Visualize and choose it from Saved charts. Dataset and version are unchanged.`,
						"muted",
					),
				);
			if (proposal.preview) {
				const receipt = proposal.preview;
				card.append(
					node("p", `Preview: ${receipt.id} · expires ${receipt.expiresAt}`, "chat-file-hash"),
					node(
						"p",
						`Sample: ${receipt.sampleSize} / ${receipt.populationRows} rows · ${receipt.sampled ? "sampled, not population estimates" : "all rows"}`,
					),
					node(
						"p",
						`Artifact SHA-256: ${receipt.datasetVersionHash} · Spec SHA-256: ${receipt.specHash}`,
						"chat-file-hash",
					),
				);
				if (proposal.state === "previewed") {
					if (validChartPreview(proposal)) expiresAt = Math.min(expiresAt, Date.parse(receipt.expiresAt));
					else card.append(node("p", "This preview has expired. Preview again before approving.", "muted"));
				}
				const local = chartPreviews.get(proposal.id);
				if (local?.previewId === receipt.id) {
					const preview = node("details", undefined, "chat-chart-preview");
					preview.id = `${prefix}-result`;
					preview.dataset.previewId = receipt.id;
					preview.open = openDetails.has(preview.id) || previousPreviews.get(preview.id) !== receipt.id;
					preview.append(node("summary", "Local chart preview — expand or collapse"), local.canvas);
					const python = node("details");
					python.id = `${prefix}-python`;
					python.open = openDetails.has(python.id);
					const code = node("pre", local.python, "assistant-exact");
					code.tabIndex = 0;
					python.append(node("summary", "Inspect generated Python (not executed or shared)"), code);
					card.append(preview, python);
				} else if (proposal.state === "previewed")
					card.append(
						node(
							"p",
							"Only the saved preview receipt is available after reload. Preview again to inspect the chart before approving.",
							"muted",
						),
					);
			}
			const audit = node("details");
			audit.id = `${prefix}-audit`;
			audit.open = openDetails.has(audit.id);
			audit.append(node("summary", "Audit timeline"));
			const timeline = node("ol");
			for (const event of proposal.audit)
				timeline.append(node("li", `${event.at} · ${event.actor} · ${event.action.replaceAll("_", " ")}`));
			audit.append(timeline);
			card.append(audit);
			const blocked = busy() || loadingChartProposals || proposalActionBusy();
			const preview = node("button", "Preview chart", "button");
			preview.id = `${prefix}-preview`;
			preview.type = "button";
			preview.disabled =
				blocked ||
				settingsSaving ||
				mode === "plan" ||
				stale ||
				!["proposed", "previewed", "failed"].includes(proposal.state);
			preview.addEventListener("click", () => {
				void actOnChartProposal(proposal.id, "preview");
			});
			const approve = node("input");
			approve.id = `${prefix}-approve`;
			approve.type = "checkbox";
			approve.checked = !!proposal.preview && chartApprovals.get(proposal.id) === proposal.preview.id;
			approve.disabled = blocked || settingsSaving || mode === "plan" || stale || !renderedChartPreview(proposal);
			const label = node("label", undefined, "assistant-check");
			label.append(
				approve,
				node(
					"span",
					proposal.preview
						? `I approve this exact preview (${proposal.preview.id}) to save this chart for version ${proposal.inputVersionId}. No dataset changes.`
						: "Preview this chart locally before approving it.",
				),
			);
			const save = node("button", "Allow once · save chart", "button button-primary");
			save.id = `${prefix}-save`;
			save.type = "button";
			save.disabled = approve.disabled || !approve.checked;
			approve.addEventListener("change", () => {
				if (approve.disabled || !renderedChartPreview(proposal)) return;
				if (approve.checked) chartApprovals.set(proposal.id, proposal.preview!.id);
				else {
					chartApprovals.delete(proposal.id);
					sessionGrants.delete(grant);
				}
				save.disabled = !approve.checked;
			});
			save.addEventListener("click", () => {
				void actOnChartProposal(proposal.id, "save");
			});
			const reject = node("button", "Deny", "button");
			reject.id = `${prefix}-reject`;
			reject.type = "button";
			reject.disabled = blocked || ["saved", "rejected", "previewing"].includes(proposal.state);
			reject.addEventListener("click", () => {
				void actOnChartProposal(proposal.id, "reject");
			});
			const controls = node("div", undefined, "chat-proposal-actions");
			const always = node("button", "Always allow this session", "button");
			always.type = "button";
			always.id = `${prefix}-always`;
			always.title =
				"Remember only this exact rendered chart preview, version and specification. New previews need approval. Saving still requires your action.";
			always.disabled = approve.disabled;
			const grant = JSON.stringify([
				conversation?.id,
				"chart",
				proposal.id,
				proposal.inputVersionId,
				proposal.spec,
				proposal.preview,
			]);
			if (!approve.disabled && sessionGrants.has(grant)) {
				approve.checked = true;
				chartApprovals.set(proposal.id, proposal.preview!.id);
				save.disabled = false;
			}
			always.addEventListener("click", () => {
				if (approve.disabled || !renderedChartPreview(proposal)) return;
				sessionGrants.add(grant);
				chartApprovals.set(proposal.id, proposal.preview!.id);
				approve.checked = true;
				save.disabled = false;
				localNotice =
					"Approval remembered only for this exact chart preview. Choose save to execute; other operations still need approval.";
				renderComposer();
			});
			controls.append(preview, save, always, reject);
			card.append(label, controls);
			chartProposalCards.append(card);
		}
		if (focused) document.getElementById(focused)?.focus();
		if (Number.isFinite(expiresAt))
			chartProposalExpiryTimer = document.defaultView!.setTimeout(
				() => {
					invalidateChartApproval();
					render();
				},
				Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now())),
			);
	}
	function resultText(item: AssistantExecutionReference): string {
		const counts = Object.entries(item.impact ?? {})
			.map(([key, value]) => `${key}: ${value}`)
			.join(", ");
		return `${item.kind} · ${item.state} · ${item.id} · ${item.inputVersionId} → ${item.outputVersionId ?? "no output"} · ${item.createdAt}${item.completedAt ? ` · completed ${item.completedAt}` : ""}${counts ? ` · ${counts}` : ""}`;
	}
	function renderContext(): void {
		const frozen = conversation?.scope.context;
		datasetSelect.replaceChildren();
		for (const value of context?.datasets ?? (context ? [context.dataset] : [])) {
			const choice = option(value.id);
			choice.textContent = value.name;
			datasetSelect.append(choice);
		}
		datasetSelect.value = context?.dataset.id ?? "";
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
				chip(`Original disclosure provider: ${conversation!.scope.provider} / ${conversation!.scope.modelId}`);
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
		screenshotList.replaceChildren();
		const images = conversation?.scope.screenshots ?? (conversation ? [] : screenshots);
		for (const [index, image] of images.entries()) {
			const entry = node("li");
			const inspect = node("details");
			inspect.append(
				node("summary", `${image.name} · ${image.byteLength} bytes · ${conversation ? "saved" : "local draft"}`),
			);
			const preview = node("img");
			preview.alt = `Inspect ${image.name} before sharing`;
			preview.src = `data:${image.mediaType};base64,${image.data}`;
			preview.loading = "lazy";
			inspect.append(preview);
			if ("sha256" in image) inspect.append(node("p", `SHA-256: ${image.sha256}`, "chat-file-hash"));
			entry.append(inspect);
			if (!conversation) {
				const remove = node("button", "Remove image", "button");
				remove.type = "button";
				remove.addEventListener("click", () => {
					if (busy() || readingFiles) return;
					screenshots.splice(index, 1);
					screenshotConsent.checked = false;
					renderContext();
					renderComposer();
				});
				entry.append(remove);
			}
			screenshotList.append(entry);
		}
		screenshotLabel.hidden = !!conversation || !screenshots.length;
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
		renderSessions();
		renderMessages();
		renderComposer();
		renderProposals();
		renderChartProposals();
		renderActivity();
	}
	function renderComposer(): void {
		const active = busy();
		agent.disabled = !context || active || staleConversation();
		agentInstructions.textContent = messageWithRole();
		datasetSelect.disabled = !context || busy() || !options.onDatasetSelected;
		newSession.disabled = !context || active || sessionSaving || settingsSaving;
		input.disabled = !context || active || staleConversation();
		provider.disabled = active || settingsSaving;
		model.disabled = active || settingsSaving || loadingSessions || loadingModel || proposalActionBusy();
		const selected = currentModelState();
		const selectedModel = selected?.model;
		const available = modelStateReady && !!selectedModel && availableModels.some((item) => item.provider === selectedModel.provider && item.id === selectedModel.id);
		model.textContent = modelLabel(selected);
		provider.textContent = selectedModel ? `Manage providers · ${selectedModel.provider}` : "Connect a provider";
		recipientNote.textContent = selectedModel?.virtual
			? "Auto may route future messages and the approved history to any available configured provider. Selecting a model does not send a message or change the approved context."
			: selectedModel ? `Next Send shares your message and approved history with ${selectedModel.provider}. Selecting a model does not send a message or change the approved context.` : "Connect a provider and choose a Pi model. No messages are sent by connecting.";
		const levels = selectedModel?.thinkingLevels ?? [];
		if ([...reasoning.options].map((item) => item.value).join(",") !== levels.join(",")) {
			reasoning.replaceChildren(...levels.map(option));
		}
		fileInput.disabled =
			fileConsent.disabled =
			screenshotConsent.disabled =
			attach.disabled =
				!context || active || loadingSessions || readingFiles || !!conversation;
		for (const button of [...fileList.querySelectorAll("button"), ...screenshotList.querySelectorAll("button")])
			button.disabled = active || readingFiles;
		for (const check of resultChoices.querySelectorAll("input"))
			check.disabled = loadingSessions || active || (!check.checked && executionIds.size >= 8);
		send.disabled =
			!context ||
			active ||
			settingsSaving ||
			sessionSaving ||
			loadingModel ||
			!available ||
			staleConversation() ||
			proposalActionBusy() ||
			loadingSessions ||
			readingFiles ||
			!input.value.trim() ||
			(!conversation &&
				(!selectedModel ||
					(attachments.length > 0 && !fileConsent.checked) ||
					(screenshots.length > 0 && !screenshotConsent.checked)));
		send.hidden = active && !!conversation;
		cancel.hidden = !active || !conversation;
		modeSelect.disabled = !context || active || settingsSaving || proposalActionBusy();
		reasoning.disabled = active || settingsSaving || loadingModel || !available || proposalActionBusy() || !levels.length;
		modeSelect.value = mode;
		reasoning.value = selected?.thinkingLevel ?? "";
		modeNote.textContent =
			mode === "plan"
				? "Plan is read only. Pi can discuss a plan, but cannot propose, apply or save operations."
				: "Execute proposes only validated renames and charts. Every exact preview needs your approval; no shell or Python execution.";
		heading.textContent = conversation?.title ?? "New session";
		const frozen = conversation?.scope.context;
		headerPath.textContent = context
			? `${frozen?.project.name ?? context.projectId} / ${frozen?.dataset.name ?? context.dataset.name} / ${conversation?.scope.datasetVersionId ?? context.dataset.currentVersionId}${conversation ? " · frozen" : ""}`
			: "No dataset selected";
		const error = feedbackError || conversation?.error;
		const state =
			error || conversation?.state === "failed"
				? "Error"
				: active
					? "Running"
					: !context
						? "Choose a dataset"
						: loadingSessions || loadingModel
							? "Loading"
							: !available
								? "Choose an available model"
								: "Ready";
		headerStatus.textContent = `${state} · ${modelLabel(selected)}`;
		headerStatus.dataset.state = error || conversation?.state === "failed" ? "error" : active ? "running" : "ready";
		headerStatus.title = error || (selectedModel ? `${selectedModel.provider} / ${selectedModel.id}` : "Choose a model through Pi");
		usage.textContent = conversation ? `${conversation.usage.totalTokens.toLocaleString()} tokens` : "No usage yet";
		usage.title = conversation
			? `Input ${conversation.usage.input} · output ${conversation.usage.output} · cache read ${conversation.usage.cacheRead} · cache write ${conversation.usage.cacheWrite}`
			: "Usage appears after a provider response";
		for (const button of exports.querySelectorAll("button")) button.disabled = !conversation;
		consentSummary.textContent = conversation
			? `Frozen metadata · ${frozen?.attachedFiles?.length ?? 0} files · ${conversation.scope.screenshots?.length ?? 0} images · inspect Context`
			: `Metadata only · no automatic row samples${attachments.length ? ` · ${attachments.length} files ${fileConsent.checked ? "approved" : "await consent"}` : ""}${screenshots.length ? ` · ${screenshots.length} images ${screenshotConsent.checked ? "approved" : "await consent"}` : ""} · inspect Context before Send`;
		consentSummary.textContent += selectedModel?.virtual
			? " · Auto: next Send may share approved history with any available configured provider"
			: selectedModel ? ` · Next Send: ${selectedModel.provider} / ${selectedModel.id}` : " · Choose a provider and model before Send";
		feedback.textContent =
			feedbackError ||
			conversation?.error ||
			streamStatus ||
			(staleConversation()
				? "This chat uses an older dataset version. Start a New chat to send messages about the current version; its proposals and audit remain available above."
				: "") ||
			(readingFiles
				? "Reading files locally…"
				: loadingSessions
					? "Loading chats…"
					: active
						? "Pi is responding…"
						: localNotice);
		feedback.className = feedbackError || conversation?.error ? "inline-error" : "muted";
		feedback.hidden = !feedback.textContent;
	}
	function messageWithRole(): string {
		const role = AGENT_ROLES.find((item) => item.id === agent.value) ?? AGENT_ROLES[0];
		return input.value.trim() ? `${role.instructions}\n\n${input.value.trim()}` : role.instructions;
	}
	function fillDraft(text: string, notice = ""): void {
		if (busy()) return;
		for (const role of AGENT_ROLES) {
			const prefix = `${role.instructions}\n\n`;
			if (!text.startsWith(prefix)) continue;
			agent.value = role.id;
			text = text.slice(prefix.length);
			break;
		}
		input.value = text;
		localNotice = notice;
		autosize();
		renderComposer();
		input.focus();
	}
	function autosize(): void {
		input.style.height = "auto";
		const lineHeight = Number.parseFloat(document.defaultView!.getComputedStyle(input).lineHeight) || 24;
		input.style.height = `${Math.min(lineHeight * 6 + 20, Math.max(lineHeight + 20, input.scrollHeight))}px`;
		input.style.overflowY = input.scrollHeight > lineHeight * 6 + 20 ? "auto" : "hidden";
	}
	function renderMessages(): void {
		const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96;
		const key = `${conversation?.id}:${context?.dataset.id}:${availableModels.length}:${loadingSessions}`;
		if (key !== transcriptRenderKey || renderedMessages !== conversation?.messages) {
			transcriptRenderKey = key;
			renderedMessages = conversation?.messages;
			messages.replaceChildren();
			if (!conversation?.messages.length) {
				const empty = node("div", undefined, "chat-empty-state");
				empty.append(
					node("h3", context ? "What would you like to understand?" : "Start with your data"),
					node(
						"p",
						context
							? "Ask Pi to explore metadata, explain patterns, or plan your next analysis. You stay in control of changes."
							: "Choose or import a dataset to start a private, locally saved session.",
					),
				);
				if (!context) {
					const choose = node("button", "Choose a dataset", "button");
					choose.type = "button";
					choose.addEventListener("click", () => navigate("data"));
					empty.append(choose);
				} else if (!availableModels.some((item) => !item.virtual)) {
					const configure = node("button", "Connect a provider", "button");
					configure.type = "button";
					configure.addEventListener("click", () => providers.open());
					empty.append(configure);
				} else
					for (const [label, prompt] of [
						[
							"Understand this dataset",
							"Summarize this dataset's schema and available profile evidence. Separate observations from hypotheses and explain limitations.",
						],
						[
							"Check data quality",
							"Review the available profile metrics for missing values, types and potential quality issues. Do not infer unseen rows.",
						],
						[
							"Plan an analysis",
							"Propose a step-by-step analysis plan using the available columns, chart metadata and profile evidence. Explain what additional evidence is needed.",
						],
					]) {
						const button = node("button", label, "button");
						button.type = "button";
						button.addEventListener("click", () => fillDraft(prompt!));
						empty.append(button);
					}
				messages.append(empty);
			}
			for (const item of conversation?.messages ?? []) {
				const article = node("article", undefined, `assistant-history-item conversation-${item.role}`);
				article.dataset.messageId = item.id;
				const label = node("header", undefined, "chat-message-header");
				label.append(
					node("strong", item.role === "user" ? "You" : "Pi"),
					node(
						"time",
						`${new Date(item.createdAt).toLocaleTimeString()}${item.state !== "complete" ? ` · ${item.state}` : ""}`,
					),
				);
				if (item.role === "assistant" && item.model) label.append(node("span", `${item.model.name} · ${item.model.provider} / ${item.model.id}${item.model.thinkingLevel ? ` · ${item.model.thinkingLevel}` : ""}`, "muted"));
				const content = node("div", undefined, "chat-message-content");
				if (item.role === "user") content.textContent = item.text;
				else renderMessageContent(content, item.text);
				const actions = node("div", undefined, "chat-message-actions");
				const copy = node("button", "Copy", "button");
				copy.type = "button";
				copy.addEventListener("click", () => {
					void Promise.resolve()
						.then(() => document.defaultView!.navigator.clipboard.writeText(item.text))
						.then(() => {
							localNotice = "Message copied.";
							renderComposer();
						})
						.catch((error) => {
							feedbackError = `Copy failed: ${options.message(error)}`;
							renderComposer();
						});
				});
				const revise = node("button", item.role === "user" ? "Edit & resend" : "Regenerate", "button");
				revise.type = "button";
				revise.dataset.requiresIdle = "true";
				revise.addEventListener("click", () =>
					fillDraft(
						item.role === "user"
							? item.text
							: "Please give an alternative answer to my preceding question. Reassess the available evidence and explain any uncertainty.",
						"Review this draft and Send. It adds a new turn; saved history is unchanged.",
					),
				);
				actions.append(copy, revise);
				if (item.state !== "complete") {
					const retry = node("button", "Retry", "button");
					retry.type = "button";
					retry.dataset.requiresIdle = "true";
					retry.addEventListener("click", () =>
						fillDraft(
							item.role === "user"
								? item.text
								: "Please retry the previous answer, using only the available evidence.",
							"Review and Send to retry as a new turn.",
						),
					);
					actions.append(retry);
				}
				if (item.role === "assistant") {
					const feedbackKey = `datapi:feedback:${conversation!.projectId}:${conversation!.datasetId}:${conversation!.id}:${item.id}`;
					for (const [rating, text] of [
						["helpful", "Helpful"],
						["unhelpful", "Not helpful"],
					]) {
						const button = node("button", text, "button");
						button.type = "button";
						button.title = "Feedback is stored only in this browser, not sent to the provider";
						try {
							button.setAttribute(
								"aria-pressed",
								String(document.defaultView!.localStorage.getItem(feedbackKey) === rating),
							);
						} catch {
							button.setAttribute("aria-pressed", "false");
						}
						button.addEventListener("click", () => {
							try {
								document.defaultView!.localStorage.setItem(feedbackKey, rating!);
								for (const peer of actions.querySelectorAll("[aria-pressed]"))
									peer.setAttribute("aria-pressed", String(peer === button));
								localNotice = "Feedback saved locally in this browser only.";
							} catch {
								feedbackError = "Local feedback could not be saved: browser storage is unavailable.";
							}
							renderComposer();
						});
						actions.append(button);
					}
				}
				article.append(label, content, actions);
				messages.append(article);
			}
		}
		for (const button of messages.querySelectorAll<HTMLButtonElement>("[data-requires-idle]"))
			button.disabled = busy();
		for (const [kind, text] of [
			["pending-user", optimisticMessage],
			["streaming", partial],
		] as const) {
			let article = messages.querySelector<HTMLElement>(`[data-transient="${kind}"]`);
			if (!text) {
				article?.remove();
				continue;
			}
			if (!article) {
				article = node(
					"article",
					undefined,
					`assistant-history-item conversation-${kind === "streaming" ? "assistant" : "user"}`,
				);
				article.dataset.transient = kind;
				article.append(
					node("strong", kind === "streaming" ? "Pi" : "You"),
					node("div", undefined, "chat-message-content"),
				);
				messages.append(article);
			}
			const content = article.querySelector<HTMLElement>(".chat-message-content")!;
			if (content.dataset.text !== text) {
				if (kind === "streaming") renderMessageContent(content, text);
				else content.textContent = text;
				content.dataset.text = text;
			}
		}
		if (feedbackError && lastRequest && !busy() && !messages.querySelector(".chat-retry")) {
			const retry = node("button", "Retry message", "button chat-retry");
			retry.type = "button";
			retry.addEventListener("click", () =>
				fillDraft(lastRequest, "Review and Send to retry. Any saved history is kept."),
			);
			messages.append(retry);
		}
		if (!feedbackError) messages.querySelector(".chat-retry")?.remove();
		if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
	}
	function renderActivity(): void {
		const key = `${proposalRevision}:${chartProposalRevision}:${conversation?.id}:${busy()}:${streamStatus}`;
		if (key === activityRenderKey) return;
		activityRenderKey = key;
		activityList.replaceChildren();
		const operations = [...proposals, ...chartProposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		activitySummary.textContent = `Activity · ${operations.length} recorded operations${busy() ? " · Pi responding" : ""}`;
		if (busy() || streamStatus) activityList.append(node("li", streamStatus || "Pi is responding…"));
		for (const operation of operations) {
			const entry = node("li");
			const details = node("details");
			const duration = Math.max(0, Date.parse(operation.updatedAt) - Date.parse(operation.createdAt));
			details.append(
				node(
					"summary",
					`${"oldName" in operation ? `Rename ${operation.oldName} → ${operation.name}` : operation.title} · ${operation.state} · ${(duration / 1000).toFixed(1)}s recorded span`,
				),
			);
			const audit = node("ol");
			for (const event of operation.audit)
				audit.append(node("li", `${event.at} · ${event.actor} · ${event.action.replaceAll("_", " ")}`));
			details.append(audit);
			entry.append(details);
			activityList.append(entry);
		}
		if (!operations.length && !busy())
			activityList.append(node("li", "No tool operations recorded for this session."));
	}
	function currentModelState(): SessionModelState | null {
		return conversation ? conversation.modelState ?? null : draftModelState;
	}
	function modelLabel(state: SessionModelState | null): string {
		if (!state?.model) return "Choose a model";
		const label = state.model.virtual ? `${state.model.name} — Pi chooses` : state.model.name;
		return state.model.virtual && state.routedModel ? `${label} → ${state.routedModel.name}` : label;
	}
	function modelEndpoint(): string {
		return conversation ? `${datasetPath()}/conversations/${encodeURIComponent(conversation.id)}/model` : "/api/chat/model";
	}
	function acceptModelState(state: SessionModelState): void {
		modelStateReady = true;
		const previous = currentModelState()?.model;
		if (!conversation && (previous?.provider !== state.model?.provider || previous?.id !== state.model?.id)) {
			fileConsent.checked = false;
			screenshotConsent.checked = false;
		}
		if (conversation) {
			conversation = { ...conversation, modelState: state };
			remember(conversation);
		} else draftModelState = state;
	}
	async function loadModelState(): Promise<SessionModelState> {
		const owner = viewGeneration;
		const generation = ++modelStateGeneration;
		loadingModel = true;
		modelStateReady = false;
		renderComposer();
		try {
			const state = await options.api<SessionModelState>(modelEndpoint());
			if (!current(owner) || generation !== modelStateGeneration) throw new Error("The active session changed. Reopen the model picker.");
			acceptModelState(state);
			return state;
		} finally {
			if (current(owner) && generation === modelStateGeneration) {
				loadingModel = false;
				render();
			}
		}
	}
	async function refreshModelState(): Promise<void> {
		const owner = viewGeneration;
		const generation = modelStateGeneration + 1;
		try {
			await loadModelState();
		} catch (error) {
			if (current(owner) && generation === modelStateGeneration) {
				feedbackError = options.message(error);
				render();
			}
		}
	}
	async function selectModel(selection: SessionModelSelection): Promise<SessionModelState> {
		if (busy() || settingsSaving || sessionSaving || loadingSessions || proposalActionBusy()) throw new Error("Wait for the current operation before changing models.");
		const owner = viewGeneration;
		++modelStateGeneration;
		settingsSaving = true;
		modelStateReady = false;
		feedbackError = "";
		render();
		try {
			const state = await options.api<SessionModelState>(modelEndpoint(), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(selection),
			});
			if (!current(owner)) throw new Error("The active session changed. Reopen the model picker.");
			acceptModelState(state);
			sessionGrants.clear();
			invalidateApproval();
			return state;
		} finally {
			if (current(owner)) {
				settingsSaving = false;
				loadingModel = false;
				render();
			}
		}
	}
	async function loadModels(): Promise<void> {
		const owner = ++modelGeneration;
		try {
			const result = await options.api<{ models: ProviderModel[]; guidance: string }>("/api/chat/models");
			if (disposed || owner !== modelGeneration) return;
			availableModels = result.models;
		} catch (error) {
			if (disposed || owner !== modelGeneration) return;
			feedbackError = options.message(error);
		}
		render();
	}
	async function refreshModels(): Promise<void> {
		await Promise.all([loadModels(), refreshModelState()]);
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
			++sessionRevision;
			if (current(view)) {
				conversation = values.find((item) => item.id === conversation?.id) ?? values[0] ?? null;
				mode = conversation?.mode ?? "execute";
				void refreshModelState();
				renderContext();
				void loadProposals();
				void loadChartProposals();
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
	async function readScreenshots(files: File[]): Promise<void> {
		if (!context || busy() || readingFiles || loadingSessions) return;
		if (conversation) {
			feedbackError = "This session's context is frozen. Start a New session before attaching images.";
			renderComposer();
			return;
		}
		const owner = viewGeneration;
		readingFiles = true;
		screenshotConsent.checked = false;
		feedbackError = "";
		openContext();
		renderComposer();
		try {
			if (screenshots.length + files.length > CONVERSATION_SCREENSHOT_MAX_FILES)
				throw new Error(`Choose at most ${CONVERSATION_SCREENSHOT_MAX_FILES} screenshots.`);
			const next: typeof screenshots = [];
			let total = screenshots.reduce((sum, image) => sum + image.byteLength, 0);
			for (const file of files) {
				if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
					throw new Error(
						"Unsupported image. Paste or drop PNG, JPEG or WebP; images are never uploaded automatically.",
					);
				if (file.size > CONVERSATION_SCREENSHOT_FILE_BYTES)
					throw new Error("Each screenshot must be at most 2 MiB.");
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (!current(owner)) return;
				total += bytes.byteLength;
				if (!bytes.byteLength || total > CONVERSATION_SCREENSHOT_TOTAL_BYTES)
					throw new Error("Screenshots must be nonempty and at most 4 MiB in total.");
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 8192)
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
				next.push({
					name:
						file.name ||
						`screenshot-${screenshots.length + next.length + 1}.${file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1]}`,
					mediaType: file.type as ConversationScreenshotInput["mediaType"],
					data: document.defaultView!.btoa(binary),
					byteLength: bytes.byteLength,
				});
			}
			screenshots.push(...next);
			localNotice =
				"Images remain local until you inspect them, consent and Send. An image-capable model is required; the server validates image contents.";
		} catch (error) {
			if (current(owner)) feedbackError = options.message(error);
		} finally {
			if (current(owner)) {
				readingFiles = false;
				renderContext();
				renderComposer();
			}
		}
	}
	async function acceptFiles(files: File[]): Promise<void> {
		if (conversation) {
			feedbackError = "This session's context is frozen. Start a New session to attach files or images.";
			renderComposer();
			return;
		}
		const owner = viewGeneration;
		openContext();
		const images = files.filter((file) => file.type?.startsWith("image/"));
		const text = files.filter((file) => !file.type?.startsWith("image/"));
		if (text.length) await readFiles(text);
		if (images.length && current(owner)) await readScreenshots(images);
	}
	function renderSuggestions(): void {
		const before = input.value.slice(0, input.selectionStart);
		const match = /(?:^|\s)([@/])([^\s]*)$/.exec(before);
		suggestions.replaceChildren();
		suggestionIndex = 0;
		if (!match || busy()) {
			suggestions.hidden = true;
			input.setAttribute("aria-expanded", "false");
			return;
		}
		const query = match[2]!.toLocaleLowerCase();
		const entries: { label: string; value?: string; run?: () => void }[] = [];
		if (match[1] === "/")
			entries.push(
				{
					label: "/summarize · draft an evidence-based overview",
					value: "Summarize the dataset schema and available profile evidence. Distinguish observations from hypotheses and list limitations.",
				},
				{
					label: "/quality · draft a quality review",
					value: "Review missingness, types and data-quality risks using only the available profile metrics. Recommend checks without executing changes.",
				},
				{
					label: "/chart · draft a chart request",
					value: "Suggest a useful chart based on available columns and evidence. Explain the encodings and limitations before proposing a local preview.",
				},
				{
					label: "/plan · draft an analysis plan",
					value: "Design a step-by-step analysis plan for this dataset. Explain the question, relevant columns, evidence, and validation required.",
				},
				{ label: "/context · inspect shared context", run: openContext },
				{ label: "/new · start a new session", run: () => selectSession(null) },
				{ label: "/data · open dataset tools", run: () => navigate("data") },
			);
		else if (context) {
			const frozen = conversation?.scope.context;
			entries.push({
				label: `dataset: ${frozen?.dataset.name ?? context.dataset.name}`,
				value: `@dataset:${frozen?.dataset.id ?? context.dataset.id}`,
			});
			for (const column of frozen?.schema ?? context.dataset.schema)
				entries.push({ label: `column: ${column.name}`, value: `@column:${column.index}(${column.name})` });
			for (const file of frozen?.attachedFiles ?? (conversation ? [] : attachments))
				entries.push({ label: `file: ${file.name}`, value: `@file:${file.name}` });
			for (const item of frozen?.artifacts ?? charts)
				entries.push({ label: `chart: ${item.name}`, value: `@chart:${item.id}(${item.name})` });
			for (const item of frozen?.executionResults ?? executions.filter((item) => executionIds.has(item.id)))
				entries.push({ label: `result: ${item.kind} · ${item.id}`, value: `@result:${item.id}` });
		}
		const start = before.length - match[2]!.length - 1;
		for (const [index, entry] of entries
			.filter((item) => item.label.toLocaleLowerCase().includes(query))
			.slice(0, 12)
			.entries()) {
			const choice = node("button", entry.label, "chat-suggestion");
			choice.type = "button";
			choice.id = `conversation-suggestion-${index}`;
			choice.setAttribute("role", "option");
			choice.setAttribute("aria-selected", String(index === 0));
			choice.addEventListener("click", () => {
				if (entry.run) {
					input.value = `${input.value.slice(0, start)}${input.value.slice(input.selectionStart)}`;
					entry.run();
				} else if (match[1] === "/")
					fillDraft(entry.value!, "Workflow inserted as a draft. Review and Send; nothing has run.");
				else {
					input.setRangeText(`${entry.value} `, start, input.selectionStart, "end");
					input.focus();
				}
				suggestions.hidden = true;
				input.setAttribute("aria-expanded", "false");
				autosize();
				renderComposer();
			});
			suggestions.append(choice);
		}
		suggestions.hidden = !suggestions.children.length;
		input.setAttribute("aria-expanded", String(!suggestions.hidden));
		if (!suggestions.hidden) input.setAttribute("aria-activedescendant", "conversation-suggestion-0");
		else input.removeAttribute("aria-activedescendant");
	}
	async function readFiles(files: File[] = [...(fileInput.files ?? [])]): Promise<void> {
		if (!context || conversation || busy() || loadingSessions || readingFiles) return;
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
			staleConversation() ||
			proposalActionBusy() ||
			loadingSessions ||
			readingFiles ||
			settingsSaving ||
			sessionSaving ||
			loadingModel ||
			!modelStateReady ||
			!currentModelState()?.model ||
			!availableModels.some((item) => item.provider === currentModelState()?.model?.provider && item.id === currentModelState()?.model?.id) ||
			(!conversation &&
				((attachments.length > 0 && !fileConsent.checked) ||
					(screenshots.length > 0 && !screenshotConsent.checked)))
		)
			return;
		const owner = viewGeneration;
		const endpoint = `${datasetPath()}/conversations`;
		const request = input.value.trim();
		const message = messageWithRole();
		lastRequest = message;
		sending = true;
		invalidateApproval();
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
						request,
						provider: currentModelState()!.model!.provider,
						modelId: currentModelState()!.model!.id,
						mode,
						reasoningEffort: currentModelState()!.thinkingLevel,
						...(screenshots.length
							? {
									screenshots: screenshots.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
									screenshotConsent: true,
								}
							: {}),
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
				renderContext();
			}
			const id = conversation.id;
			optimisticMessage = message;
			input.value = "";
			autosize();
			suggestions.hidden = true;
			streamStatus = "Pi is responding…";
			render();
			const value = await options.stream(`${endpoint}/${encodeURIComponent(id)}/messages`, message, (event) => {
				if (!current(owner) || event.conversationId !== id) return;
				if (event.type === "text") {
					partial += event.delta;
					streamStatus = "Pi is responding…";
				} else {
					streamStatus = event.error ?? (event.state === "running" ? "Pi is responding…" : "");
					if (event.error) feedbackError = event.error;
				}
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
				void loadProposals();
				void loadChartProposals();
			}
		}
	}
	newSession.addEventListener("click", () => selectSession(null));
	contextToggle.addEventListener("click", () => {
		if (contextPanel.hidden) openContext();
		else hideContext();
	});
	closeContext.addEventListener("click", hideContext);
	contextPanel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			hideContext();
		}
	});
	inspectContext.addEventListener("click", openContext);
	attach.addEventListener("click", () => {
		openContext();
		fileInput.click();
	});
	dataLink.addEventListener("click", () => navigate("data"));
	datasetSelect.addEventListener("change", () => {
		if (busy() || !options.onDatasetSelected) return;
		const id = datasetSelect.value;
		void Promise.resolve()
			.then(() => options.onDatasetSelected!(id))
			.catch((error) => {
				feedbackError = options.message(error);
				datasetSelect.value = context?.dataset.id ?? "";
				renderComposer();
			});
	});
	input.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		const choices = [...suggestions.querySelectorAll<HTMLButtonElement>("button")];
		if (!suggestions.hidden && choices.length) {
			if (event.key === "Escape") {
				event.preventDefault();
				suggestions.hidden = true;
				input.setAttribute("aria-expanded", "false");
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				suggestionIndex =
					(suggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
				for (const [index, choice] of choices.entries())
					choice.setAttribute("aria-selected", String(index === suggestionIndex));
				input.setAttribute("aria-activedescendant", choices[suggestionIndex]!.id);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				choices[suggestionIndex]!.click();
				return;
			}
		}
		if (keybindings.newline.some((binding) => matchesAppKeybinding(event, binding))) {
			event.preventDefault();
			input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
			autosize();
			renderComposer();
		} else if (keybindings.sendMessage.some((binding) => matchesAppKeybinding(event, binding))) {
			event.preventDefault();
			void sendMessage();
		}
	});
	input.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.files ?? [])];
		if (!files.length) return;
		event.preventDefault();
		void acceptFiles(files);
	});
	form.addEventListener("dragover", (event) => {
		if (event.dataTransfer?.types.includes("Files")) {
			event.preventDefault();
			form.classList.add("is-dragging");
		}
	});
	form.addEventListener("dragleave", () => form.classList.remove("is-dragging"));
	form.addEventListener("drop", (event) => {
		event.preventDefault();
		form.classList.remove("is-dragging");
		void acceptFiles([...(event.dataTransfer?.files ?? [])]);
	});
	const onNewSession = () => selectSession(null);
	const onSettings = () => providers.open();
	const onTools = () => {
		activity.open = true;
		activity.scrollIntoView?.({ block: "nearest" });
	};
	document.addEventListener("workbench:new-session", onNewSession);
	document.addEventListener("workbench:open-settings", onSettings);
	document.addEventListener("workbench:open-tools", onTools);
	reloadProposals.addEventListener("click", () => {
		if (conversation && !busy() && !loadingProposals && !proposalActionBusy()) void loadProposals();
	});
	reloadChartProposals.addEventListener("click", () => {
		if (conversation && !busy() && !loadingChartProposals && !proposalActionBusy()) void loadChartProposals();
	});
	provider.addEventListener("click", () => providers.open());
	model.addEventListener("click", () => providers.openModelPicker());
	agent.addEventListener("change", renderComposer);
	input.addEventListener("input", () => {
		autosize();
		renderSuggestions();
		renderComposer();
	});
	fileInput.addEventListener("change", () => {
		const files = [...(fileInput.files ?? [])];
		fileInput.value = "";
		void acceptFiles(files);
	});
	fileConsent.addEventListener("change", render);
	screenshotConsent.addEventListener("change", renderComposer);
	sessionSearch.addEventListener("input", renderSessions);
	modeSelect.addEventListener("change", () => {
		void saveSettings();
	});
	reasoning.addEventListener("change", () => {
		const selected = currentModelState()?.model;
		const thinkingLevel = selected?.thinkingLevels.find((level) => level === reasoning.value);
		if (!selected || !thinkingLevel) return;
		void selectModel({ provider: selected.provider, modelId: selected.id, thinkingLevel, persist: false }).catch((error) => {
			feedbackError = options.message(error);
			render();
		});
	});
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
		initialize: refreshModels,
		update(value) {
			if (disposed) return;
			const changed = context?.projectId !== value?.projectId || context?.dataset.id !== value?.dataset.id;
			const versionChanged = context?.dataset.currentVersionId !== value?.dataset.currentVersionId;
			const revisionChanged =
				context?.revision !== value?.revision ||
				context?.selectedColumns.join(",") !== value?.selectedColumns.join(",") ||
				JSON.stringify(context?.filters) !== JSON.stringify(value?.filters) ||
				context?.profile !== value?.profile;
			context = value;
			if (changed) {
				++scopeGeneration;
				++viewGeneration;
				providers.close();
				++modelStateGeneration;
				++modelGeneration;
				++metadataGeneration;
				conversation = null;
				sessions = [];
				++sessionRevision;
				sessionGrants.clear();
				mode = "execute";
				loadingModel = !!value;
				settingsSaving = false;
				sessionSaving = false;
				charts = [];
				executions = [];
				sending = false;
				loadingSessions = false;
				clearDraft();
				clearTranscript();
				clearProposals();
				input.value = "";
				if (value) {
					void loadModels();
					void loadConversations();
					void loadMetadata();
				} else void refreshModelState();
			} else if (value && (versionChanged || revisionChanged)) {
				sessionGrants.clear();
				invalidateApproval();
				void loadMetadata();
				void loadProposals();
				void loadChartProposals();
			}
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
			clearProposals();
			document.defaultView!.clearTimeout(proposalExpiryTimer);
			document.defaultView!.clearTimeout(chartProposalExpiryTimer);
			document.removeEventListener("workbench:new-session", onNewSession);
			document.removeEventListener("workbench:open-settings", onSettings);
			providers.dispose();
			if (!existingProvidersRoot) providersRoot.remove();
			document.removeEventListener("workbench:open-tools", onTools);
			if (sidebarHost) sidebar.remove();
		},
	};
}
