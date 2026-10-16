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
import type { DatasetProfile } from "../profile-contracts.ts";
import type { TransformHistory } from "../transform-contracts.ts";
import { renderChart } from "./chart-renderer.ts";

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
	onChanged(dataset: Dataset): Promise<void> | void;
	onChartSaved(chart: ChartRecord): Promise<void> | void;
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
	const heading = node("h2", "Ask about this dataset");
	const disclosure = node(
		"p",
		"Chat shares dataset metadata and your messages with the chosen provider, never automatic row samples. Pi can propose column renames and charts; it cannot execute or save them directly. You must preview and approve locally before a rename is applied or a chart is saved. Optional files are shared only after your consent and Send; they are never executed.",
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
	chatMain.append(heading, disclosure, scopeDetails, messages, proposalPanel, chartProposalPanel, form);
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
		const key = `${proposalRevision}:${busy()}:${pending?.id}:${pending?.action}:${proposalActionBusy()}`;
		if (key === proposalRenderKey) return;
		proposalRenderKey = key;
		document.defaultView!.clearTimeout(proposalExpiryTimer);
		proposalPanel.hidden = !conversation;
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
			preview.disabled = blocked || stale || !["proposed", "previewed", "failed"].includes(proposal.state);
			preview.addEventListener("click", () => {
				void actOnProposal(proposal.id, "preview");
			});
			const approve = node("input");
			approve.id = `${prefix}-approve`;
			approve.type = "checkbox";
			approve.checked = approvals.get(proposal.id) === proposal.preview?.id && !!proposal.preview;
			approve.disabled = blocked || stale || !validPreview(proposal);
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
			const apply = node("button", "Approve and apply", "button button-primary");
			apply.id = `${prefix}-apply`;
			apply.type = "button";
			apply.disabled = approve.disabled || !approve.checked;
			approve.addEventListener("change", () => {
				if (approve.disabled || !validPreview(proposal)) return;
				if (approve.checked) approvals.set(proposal.id, proposal.preview!.id);
				else approvals.delete(proposal.id);
				apply.disabled = !approve.checked;
			});
			apply.addEventListener("click", () => {
				void actOnProposal(proposal.id, "apply");
			});
			const reject = node("button", "Reject", "button");
			reject.id = `${prefix}-reject`;
			reject.type = "button";
			reject.disabled = blocked || ["applied", "rejected", "previewing", "applying"].includes(proposal.state);
			reject.addEventListener("click", () => {
				void actOnProposal(proposal.id, "reject");
			});
			const controls = node("div", undefined, "chat-proposal-actions");
			controls.append(preview, apply, reject);
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
		const key = `${chartProposalRevision}:${busy()}:${pending?.id}:${pending?.action}:${proposalActionBusy()}`;
		if (key === chartProposalRenderKey) return;
		chartProposalRenderKey = key;
		document.defaultView!.clearTimeout(chartProposalExpiryTimer);
		chartProposalPanel.hidden = !conversation;
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
			preview.disabled = blocked || stale || !["proposed", "previewed", "failed"].includes(proposal.state);
			preview.addEventListener("click", () => {
				void actOnChartProposal(proposal.id, "preview");
			});
			const approve = node("input");
			approve.id = `${prefix}-approve`;
			approve.type = "checkbox";
			approve.checked = !!proposal.preview && chartApprovals.get(proposal.id) === proposal.preview.id;
			approve.disabled = blocked || stale || !renderedChartPreview(proposal);
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
			const save = node("button", "Save chart", "button button-primary");
			save.id = `${prefix}-save`;
			save.type = "button";
			save.disabled = approve.disabled || !approve.checked;
			approve.addEventListener("change", () => {
				if (approve.disabled || !renderedChartPreview(proposal)) return;
				if (approve.checked) chartApprovals.set(proposal.id, proposal.preview!.id);
				else chartApprovals.delete(proposal.id);
				save.disabled = !approve.checked;
			});
			save.addEventListener("click", () => {
				void actOnChartProposal(proposal.id, "save");
			});
			const reject = node("button", "Reject", "button");
			reject.id = `${prefix}-reject`;
			reject.type = "button";
			reject.disabled = blocked || ["saved", "rejected", "previewing"].includes(proposal.state);
			reject.addEventListener("click", () => {
				void actOnChartProposal(proposal.id, "reject");
			});
			const controls = node("div", undefined, "chat-proposal-actions");
			controls.append(preview, save, reject);
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
			const historical = item.scope.datasetVersionId !== context?.dataset.currentVersionId;
			const select = node("button", `${item.title}${historical ? " · older version" : ""}`, "button");
			select.type = "button";
			select.setAttribute("aria-current", String(item.id === conversation?.id));
			select.disabled = active || item.id === conversation?.id;
			select.addEventListener("click", () => {
				if (busy()) return;
				++viewGeneration;
				conversation = structuredClone(item);
				clearProposals();
				clearDraft();
				clearTranscript();
				input.value = "";
				populateModels();
				renderContext();
				render();
				void loadProposals();
				void loadChartProposals();
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
		input.disabled = !context || active || staleConversation();
		provider.disabled = model.disabled = !context || active || !!conversation;
		fileInput.disabled = fileConsent.disabled =
			!context || active || loadingSessions || readingFiles || !!conversation;
		for (const button of fileList.querySelectorAll("button")) button.disabled = active || readingFiles;
		for (const check of resultChoices.querySelectorAll("input"))
			check.disabled = loadingSessions || active || (!check.checked && executionIds.size >= 8);
		send.disabled =
			!context ||
			active ||
			staleConversation() ||
			proposalActionBusy() ||
			loadingSessions ||
			readingFiles ||
			!input.value.trim() ||
			(!conversation && (!model.value || (attachments.length > 0 && !fileConsent.checked)));
		cancel.hidden = !active || !conversation;
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
						: "");
		feedback.hidden = !feedback.textContent;
		renderProposals();
		renderChartProposals();
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
				conversation = values.find((item) => item.id === conversation?.id) ?? values[0] ?? null;
				populateModels();
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
			staleConversation() ||
			proposalActionBusy() ||
			loadingSessions ||
			readingFiles ||
			(!conversation && (!model.value || (attachments.length > 0 && !fileConsent.checked)))
		)
			return;
		const owner = viewGeneration;
		const endpoint = `${datasetPath()}/conversations`;
		const message = input.value.trim();
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
				void loadProposals();
				void loadChartProposals();
			}
		}
	}
	newSession.addEventListener("click", () => {
		if (busy() || !context) return;
		++viewGeneration;
		conversation = null;
		clearProposals();
		clearDraft();
		clearTranscript();
		input.value = "";
		populateModels();
		void loadMetadata();
		renderContext();
		render();
	});
	reloadProposals.addEventListener("click", () => {
		if (conversation && !busy() && !loadingProposals && !proposalActionBusy()) void loadProposals();
	});
	reloadChartProposals.addEventListener("click", () => {
		if (conversation && !busy() && !loadingChartProposals && !proposalActionBusy()) void loadChartProposals();
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
				clearProposals();
				input.value = "";
				credentialKey.value = "";
				if (value) {
					void loadModels();
					void loadConversations();
					void loadMetadata();
				}
			} else if (value && (versionChanged || revisionChanged)) {
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
			credentialKey.value = "";
		},
	};
}
