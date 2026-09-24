import type { AssistantModels } from "../assistant-contracts.ts";
import type { ChartFilter } from "../chart-contracts.ts";
import type { Dataset } from "../contracts.ts";
import type { Conversation, ConversationEvent } from "../conversation-contracts.ts";
import type { DatasetProfile } from "../profile-contracts.ts";

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

export function initializeConversation(container: HTMLElement, options: ConversationOptions): ConversationController {
	const document = container.ownerDocument;
	let context: ConversationUiContext | null = null;
	let conversation: Conversation | null = null;
	let partial = "";
	let optimisticMessage: string | null = null;
	let sending = false;
	let sessions: Conversation[] = [];
	let streamStatus = "";
	let feedbackError = "";
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
	const heading = node("h2", "Ask about this dataset");
	const disclosure = node(
		"p",
		"Chat uses the selected provider and the current, read-only dataset context. Data changes require a new conversation.",
		"muted",
	);
	const messages = node("div", undefined, "assistant-history");
	const sessionList = node("ul", undefined, "chat-session-list");
	const newSession = node("button", "New chat", "button") as HTMLButtonElement;
	newSession.type = "button";
	const sidebar = node("aside", undefined, "chat-session-sidebar");
	sidebar.append(node("h3", "Sessions"), newSession, sessionList);
	messages.setAttribute("aria-live", "polite");
	const provider = node("select") as HTMLSelectElement;
	provider.id = "conversation-provider";
	const model = node("select") as HTMLSelectElement;
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
	const credentialProvider = node("select") as HTMLSelectElement;
	credentialProvider.id = "conversation-credential-provider";
	for (const name of configuredProviders) credentialProvider.append(new Option(name, name));
	const credentialKey = node("input") as HTMLInputElement;
	credentialKey.id = "conversation-api-key";
	credentialKey.type = "password";
	credentialKey.autocomplete = "off";
	credentialKey.placeholder = "API key";
	const connect = node("button", "Connect", "button") as HTMLButtonElement;
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
	const form = node("form", undefined, "assistant-form") as HTMLFormElement;
	const input = node("textarea") as HTMLTextAreaElement;
	input.id = "conversation-message";
	input.rows = 3;
	input.maxLength = 16 * 1024;
	input.placeholder = "Ask a question about this dataset";
	input.required = true;
	const inputLabel = node("label", "Message");
	inputLabel.htmlFor = input.id;
	const send = node("button", "Send", "button button-primary") as HTMLButtonElement;
	send.type = "submit";
	const cancel = node("button", "Stop", "button") as HTMLButtonElement;
	cancel.type = "button";
	cancel.hidden = true;
	const feedback = node("p", undefined, "muted");
	feedback.setAttribute("role", "status");
	const actions = node("div", undefined, "assistant-actions");
	actions.append(send, cancel);
	form.append(controls, setup, inputLabel, input, actions, feedback);
	const chatMain = node("section", undefined, "chat-transcript");
	chatMain.append(heading, disclosure, messages, form);
	const chatShell = node("div", undefined, "chat-shell");
	chatShell.append(sidebar, chatMain);
	container.replaceChildren(chatShell);

	function path(suffix = ""): string {
		if (!context) throw new Error("Choose a dataset before starting a conversation.");
		return `/api/projects/${encodeURIComponent(context.projectId)}/datasets/${encodeURIComponent(context.dataset.id)}/conversations${suffix}`;
	}
	function render(): void {
		sessionList.replaceChildren();
		for (const item of sessions) {
			const select = node("button", item.title, "button") as HTMLButtonElement;
			select.type = "button";
			select.disabled = item.id === conversation?.id;
			select.addEventListener("click", () => {
				conversation = structuredClone(item);
				partial = "";
				render();
			});
			const entry = node("li");
			entry.append(select);
			sessionList.append(entry);
		}
		messages.replaceChildren();
		if (!conversation) {
			messages.append(
				node("p", "Start a conversation. The selected dataset context is shared once with this provider.", "muted"),
			);
		} else {
			for (const item of conversation.messages) {
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
		}
		const active = sending && !!conversation;
		input.disabled = !context || active;
		provider.disabled = !context || active || !!conversation;
		model.disabled = !context || active || !!conversation;
		send.disabled = !context || active || !input.value.trim() || !model.value;
		cancel.hidden = !active;
		feedback.textContent = (conversation?.error ?? feedbackError) || streamStatus;
		feedback.hidden = !feedback.textContent;
	}
	function populateModels(): void {
		const selectedProvider = provider.value;
		provider.replaceChildren();
		for (const [name] of models) provider.append(new Option(name, name));
		if (models.has(selectedProvider)) provider.value = selectedProvider;
		populateModelOptions();
	}
	function populateModelOptions(): void {
		const selected = model.value;
		model.replaceChildren();
		for (const id of models.get(provider.value) ?? []) model.append(new Option(id, id));
		if ([...(models.get(provider.value) ?? [])].includes(selected)) model.value = selected;
	}
	async function loadModels(): Promise<void> {
		try {
			const result = await options.api<AssistantModels>("/api/chat/models");
			models.clear();
			for (const item of result.models.filter((item) => item.configured)) {
				const values = models.get(item.provider) ?? [];
				values.push(item.id);
				models.set(item.provider, values);
			}
			populateModels();
			if (!models.size) feedbackError = "Configure a provider API key before sending a chat message.";
		} catch (error) {
			feedbackError = options.message(error);
		}
		render();
	}
	async function loadConversation(): Promise<void> {
		if (!context) return;
		try {
			const values = await options.api<Conversation[]>(path());
			sessions = values;
			conversation =
				values.find((item) => item.scope.datasetVersionId === context?.dataset.currentVersionId) ?? null;
			partial = "";
		} catch (error) {
			feedbackError = options.message(error);
		}
		render();
	}
	async function sendMessage(): Promise<void> {
		if (!context || !input.value.trim() || sending || !model.value) return;
		const message = input.value.trim();
		try {
			if (!conversation) {
				conversation = await options.api<Conversation>(path(), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						datasetVersionId: context.dataset.currentVersionId,
						selectedColumns: context.selectedColumns,
						filters: context.filters,
						request: message,
						provider: provider.value,
						modelId: model.value,
					}),
				});
			}
			sending = true;
			feedbackError = "";
			partial = "";
			streamStatus = "Pi is responding…";
			optimisticMessage = message;
			input.value = "";
			render();
			conversation = await options.stream(
				path(`/${encodeURIComponent(conversation.id)}/messages`),
				message,
				(event) => {
					if (event.type === "text") {
						partial += event.delta;
						streamStatus = "Pi is responding…";
					} else {
						streamStatus = event.error ?? (event.state === "running" ? "Pi is responding…" : "");
					}
					render();
				},
			);
		} catch (error) {
			feedbackError = options.message(error);
		} finally {
			sending = false;
			optimisticMessage = null;
			partial = "";
			streamStatus = "";
			render();
		}
	}
	newSession.addEventListener("click", () => {
		conversation = null;
		partial = "";
		render();
	});
	connect.addEventListener("click", () => {
		if (!credentialKey.value) return;
		void options
			.api("/api/chat/credentials", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: credentialProvider.value, apiKey: credentialKey.value }),
			})
			.then(() => {
				credentialKey.value = "";
				setup.open = false;
				void loadModels();
			})
			.catch((error) => {
				feedbackError = options.message(error);
				render();
			});
	});
	provider.addEventListener("change", () => {
		populateModelOptions();
		render();
	});
	input.addEventListener("input", render);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void sendMessage();
	});
	cancel.addEventListener("click", () => {
		if (!conversation) return;
		streamStatus = "Stopping Pi…";
		render();
		void options
			.api<Conversation>(path(`/${encodeURIComponent(conversation.id)}`), { method: "DELETE" })
			.then((value) => {
				conversation = value;
			});
	});
	return {
		update(value) {
			const changed =
				context?.projectId !== value?.projectId ||
				context?.dataset.id !== value?.dataset.id ||
				context?.dataset.currentVersionId !== value?.dataset.currentVersionId;
			context = value;
			if (changed && !value) {
				conversation = null;
				partial = "";
				optimisticMessage = null;
			} else if (changed) {
				void loadModels();
				void loadConversation();
			}
			render();
		},
		dispose() {},
	};
}
