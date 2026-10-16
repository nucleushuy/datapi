import type {
	ModelThinkingLevel, ProviderAuthEvent, ProviderAuthOperation, ProviderAuthPrompt, ProviderAuthType,
	ProviderCatalog, ProviderConnectionState, ProviderModel, ProviderSummary, SessionModelSelection, SessionModelState,
} from "../provider-contracts.ts";

interface ProvidersOptions {
	root: HTMLElement;
	request<T>(path: string, init?: RequestInit): Promise<T>;
	onModelsChanged(): Promise<void> | void;
	onSelectModel(selection: SessionModelSelection): Promise<SessionModelState>;
	getModelState(): Promise<SessionModelState>;
}
export interface ProvidersController {
	open(providerId?: string): void;
	openModelPicker(): void;
	close(): void;
	dispose(): void;
}
const connectionLabels: Record<ProviderConnectionState, string> = {
	disconnected: "Not connected", connecting: "Connecting", waiting_browser: "Waiting for browser authentication",
	waiting_device: "Waiting for device-code confirmation", verifying: "Verifying", connected: "Connected",
	expired: "Token expired", reconnect_required: "Reconnection required", cancelled: "Authentication cancelled",
	failed: "Connection failed", environment: "Available through environment configuration", offline_cached: "Offline but using cached catalog",
};

/** Browser-only interaction adapter. Pi owns credentials, authentication and selected models. */
export function createProviders(options: ProvidersOptions): ProvidersController {
	const document = options.root.ownerDocument;
	const window = document.defaultView!;
	let disposed = false;
	let generation = 0;
	let catalog: ProviderCatalog | null = null;
	let provider: ProviderSummary | null = null;
	let operation: ProviderAuthOperation | null = null;
	let operationAbort: AbortController | null = null;
	let pollTimer: number | undefined;
	let expiryTimer: number | undefined;
	let previousFocus: HTMLElement | null = null;
	let cancelling = false;
	let starting = false;
	let eventSignature = "";
	let responseRevision = 0;
	const openedUrls = new Set<string>();
	const prompts = new Map<string, { form: HTMLFormElement; control: HTMLInputElement | HTMLSelectElement }>();
	function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
		const result = document.createElement(tag);
		if (text !== undefined) result.textContent = text;
		if (className) result.className = className;
		return result;
	}
	function button(text: string, action: () => void, primary = false) {
		const result = node("button", text, `button${primary ? " button-primary" : ""}`);
		result.type = "button";
		result.addEventListener("click", action);
		return result;
	}
	const dialog = node("dialog", undefined, "providers-dialog");
	dialog.setAttribute("aria-label", "Providers");
	dialog.setAttribute("aria-modal", "true");
	const header = node("header", undefined, "providers-heading");
	const headingCopy = node("div", undefined, "heading-copy");
	const heading = node("h2", "Providers");
	heading.tabIndex = -1;
	headingCopy.append(node("p", "Profile connections", "eyebrow"), heading);
	const closeButton = button("Close", () => void close());
	closeButton.classList.add("button-quiet");
	header.append(headingCopy, closeButton);
	const steps = node("ol", undefined, "providers-steps");
	steps.setAttribute("aria-label", "Connection steps");
	for (const name of ["Provider", "Account", "Authentication", "Model", "Complete"]) steps.append(node("li", name));
	const error = node("p", undefined, "inline-error providers-feedback");
	error.setAttribute("role", "alert");
	error.hidden = true;
	const body = node("div", undefined, "providers-body");
	dialog.append(header, steps, error, body);
	options.root.append(dialog);
	function report(message: string) {
		error.textContent = message;
		error.hidden = !message;
	}
	function clearTimers() {
		window.clearTimeout(pollTimer);
		window.clearInterval(expiryTimer);
		pollTimer = undefined;
		expiryTimer = undefined;
	}
	function clearPrompts() {
		for (const { control } of prompts.values()) control.value = "";
		prompts.clear();
	}
	function screen(title: string, step: number | null) {
		clearPrompts();
		window.clearInterval(expiryTimer);
		heading.textContent = title;
		dialog.setAttribute("aria-label", title);
		steps.hidden = step === null;
		for (const [index, item] of [...steps.children].entries()) {
			if (index + 1 === step) item.setAttribute("aria-current", "step");
			else item.removeAttribute("aria-current");
			item.setAttribute("data-complete", String(step !== null && index + 1 < step));
		}
		report("");
		body.replaceChildren();
		heading.focus();
	}
	function show() {
		if (disposed) return false;
		if (!dialog.open) {
			previousFocus = document.activeElement as HTMLElement | null;
			dialog.showModal();
		}
		return true;
	}
	function current(token: number) { return !disposed && dialog.open && token === generation; }
	function loading(message: string) {
		const status = node("p", message, "loading-state");
		status.setAttribute("role", "status");
		body.replaceChildren(status);
	}
	async function changed() {
		try { await options.onModelsChanged(); }
		catch { report("The connection changed, but the active session could not be refreshed. Reopen the model picker to retry."); }
	}
	function authDescription(value: ProviderSummary) {
		if (value.source === "virtual") return "Pi routing";
		if (value.source === "environment" || value.source === "configuration") return "Ambient credentials";
		if (value.authType === "oauth") return "OAuth";
		if (value.authType === "api_key") return "API key";
		const methods = [];
		if (value.auth.oauth) methods.push("OAuth");
		if (value.auth.apiKey?.interactive) methods.push("API key");
		return methods.join(" / ") || "Ambient credentials";
	}
	function renderProviders() {
		screen("Providers", 1);
		provider = null;
		const search = node("input");
		search.type = "search";
		search.placeholder = "Search providers";
		search.setAttribute("aria-label", "Search providers");
		const list = node("ul", undefined, "providers-list");
		const empty = node("p", "No providers match. Try a different name.", "providers-empty");
		function filter() {
			const query = search.value.trim().toLocaleLowerCase();
			list.replaceChildren();
			for (const value of catalog?.providers ?? []) {
				if (!`${value.name} ${value.id}`.toLocaleLowerCase().includes(query)) continue;
				const row = node("li", undefined, "provider-row");
				row.dataset.provider = value.id;
				const initials = value.name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toLocaleUpperCase();
				const icon = node("span", initials, "provider-initials");
				icon.setAttribute("aria-hidden", "true");
				const copy = node("div", undefined, "provider-row-copy");
				copy.append(node("h3", value.name));
				const status = node("span", connectionLabels[value.state], "provider-status");
				status.dataset.state = value.state;
				copy.append(status, node("p", `${authDescription(value)} · ${value.modelCount.toLocaleString()} available models`, "provider-meta"));
				if (value.message) copy.append(node("p", value.message, "provider-meta"));
				const action = button(value.configured ? "Manage" : "Connect", () => account(value));
				action.setAttribute("aria-label", `${value.configured ? "Manage" : "Connect"} ${value.name}`);
				row.append(icon, copy, action);
				list.append(row);
			}
			empty.hidden = list.childElementCount > 0;
		}
		search.addEventListener("input", filter);
		filter();
		body.append(node("p", "Connect once for this local profile. Pi manages authentication and discovers the models available to you.", "providers-intro"), search, list, empty, node("p", catalog?.guidance ?? "", "providers-footnote"), button("Choose a model", () => void loadModels(null)));
	}
	async function loadProviders(providerId?: string) {
		if (!show() || starting || (operation && !operation.done)) return;
		const token = ++generation;
		screen("Providers", 1);
		loading("Loading providers from Pi…");
		try {
			const result = await options.request<ProviderCatalog>("/api/providers");
			if (!current(token)) return;
			catalog = result;
			const selected = providerId ? result.providers.find((item) => item.id === providerId) : undefined;
			if (selected) account(selected);
			else renderProviders();
		} catch {
			if (!current(token)) return;
			body.replaceChildren(button("Try again", () => void loadProviders(providerId)));
			report("Providers could not be loaded. Check your local connection and try again.");
		}
	}
	function account(value: ProviderSummary) {
		provider = value;
		screen(`Connect ${value.name}`, 2);
		const savedKey = value.storedAuthType === "api_key";
		body.append(node("p", value.configured ? `A ${value.name} connection is already available for this profile.` : `Choose how to connect ${value.name}.`, "providers-intro"));
		if (value.configured) {
			const actions = node("div", undefined, "providers-actions");
			actions.append(button(savedKey ? "Continue with saved API key" : value.authType === "oauth" ? "Continue with connected account" : "Continue with configured connection", () => void continueProvider(value), true));
			if (savedKey && value.auth.apiKey?.interactive) actions.append(button("Replace API key", () => void startAuth(value, "api_key")));
			else if (value.authType === "oauth" && value.auth.oauth) actions.append(button("Use another account", () => void startAuth(value, "oauth")));
			if (value.storedAuthType || value.source === "runtime") actions.append(button("Disconnect", () => confirmDisconnect(value)));
			body.append(actions);
		}
		const methods = node("div", undefined, "providers-methods");
		if ((!value.configured || value.authType !== "oauth") && value.auth.oauth) {
			methods.append(button(value.auth.oauth.label, () => void startAuth(value, "oauth"), !value.configured));
			if (value.auth.oauth.subscription) methods.append(node("p", "Subscription authentication supported. This is not verification of your plan.", "providers-footnote"));
		}
		if ((!value.configured || !savedKey) && value.auth.apiKey?.interactive) methods.append(button(value.auth.apiKey.label, () => void startAuth(value, "api_key")));
		if (methods.childElementCount) body.append(methods);
		if (!value.configured && !value.auth.oauth && !value.auth.apiKey?.interactive) body.append(node("p", "This provider uses ambient configuration rather than an interactive sign-in. Configure it in the server environment, then refresh Providers.", "providers-footnote"), button("Refresh providers", () => void loadProviders(value.id)));
		if (value.auth.oauth) body.append(node("p", `You’ll sign in securely on ${value.name}. This app never asks for or sees your provider password. Connecting another account replaces the saved ${value.name} connection for this profile.`, "providers-footnote"));
		body.append(node("p", "Pi checks whether authentication is configured; this does not verify account identity, key validity, or model entitlement.", "providers-footnote"), button("Back to providers", renderProviders));
	}
	async function continueProvider(value: ProviderSummary) {
		const token = ++generation;
		loading("Checking configuration and refreshing available models…");
		try {
			const result = await options.request<ProviderCatalog>(`/api/providers/${encodeURIComponent(value.id)}/continue`, { method: "POST" });
			if (!current(token)) return;
			catalog = result;
			await changed();
			if (current(token)) await loadModels(value.id);
		} catch {
			if (!current(token)) return;
			account(value);
			report("The connection could not be continued. Try again or reconnect this provider.");
		}
	}
	function confirmDisconnect(value: ProviderSummary) {
		screen(`Disconnect ${value.name}?`, 2);
		body.append(node("p", "Disconnecting removes the credential saved by this application. It may not revoke provider access or remove credentials configured through environment variables.", "providers-intro"));
		const actions = node("div", undefined, "button-row");
		actions.append(button("Keep connection", () => account(value)), button("Disconnect", () => void disconnect(value)));
		body.append(actions);
	}
	async function disconnect(value: ProviderSummary) {
		const token = ++generation;
		loading("Removing saved connection and rechecking configuration…");
		try {
			const result = await options.request<ProviderCatalog>(`/api/providers/${encodeURIComponent(value.id)}`, { method: "DELETE" });
			if (!current(token)) return;
			catalog = result;
			renderProviders();
			await changed();
		} catch {
			if (!current(token)) return;
			confirmDisconnect(value);
			report("The saved connection could not be removed. Try again.");
		}
	}

	const authStatus = node("p", undefined, "provider-auth-status");
	authStatus.setAttribute("role", "status");
	const authEvents = node("div", undefined, "provider-auth-events");
	const authPrompts = node("div", undefined, "provider-auth-prompts");
	const authActions = node("div", undefined, "button-row");
	function authScreen(value: ProviderSummary) {
		screen(`Connect ${value.name}`, 3);
		authStatus.textContent = "Starting authentication…";
		authEvents.replaceChildren();
		authPrompts.replaceChildren();
		authActions.replaceChildren(button("Cancel authentication", () => void cancelAuth()));
		body.append(authStatus, authEvents, authPrompts, authActions);
		if (value.auth.oauth) body.append(node("p", "Choose another account on the provider page, or sign out there before continuing.", "providers-footnote"));
		body.append(node("p", "Sign-in takes place with the provider. Never enter your provider password here. Pi keeps one saved connection per provider in this profile.", "providers-footnote"));
	}
	async function startAuth(value: ProviderSummary, type: ProviderAuthType) {
		if (starting || (operation && !operation.done)) return;
		const token = ++generation;
		provider = value;
		operation = null;
		starting = true;
		clearTimers();
		operationAbort?.abort();
		operationAbort = new AbortController();
		openedUrls.clear();
		eventSignature = "";
		authScreen(value);
		try {
			const result = await options.request<ProviderAuthOperation>(`/api/providers/${encodeURIComponent(value.id)}/auth`, { method: "POST", body: JSON.stringify({ type }) });
			starting = false;
			if (!current(token)) {
				if (!result.done) await options.request(`/api/provider-auth/${encodeURIComponent(result.id)}`, { method: "DELETE", keepalive: disposed });
				return;
			}
			updateOperation(result);
		} catch {
			starting = false;
			if (!current(token)) return;
			account(value);
			report("Authentication could not be started. Try again.");
		}
	}
	function safeUrl(raw: string) {
		try {
			const url = new URL(raw);
			return /^https?:\/\//i.test(raw) && !/[\u0000-\u0020\u007f]/.test(raw) && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:");
		} catch { return false; }
	}
	function link(url: string, label: string) {
		if (!safeUrl(url)) return node("span", "The provider supplied a link that cannot be opened safely.", "inline-error");
		const anchor = node("a", label, "provider-auth-link");
		anchor.setAttribute("href", url);
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
		anchor.referrerPolicy = "no-referrer";
		return anchor;
	}
	function copyButton(text: string, label: string) {
		const copy = button(label, async () => {
			try {
				await window.navigator.clipboard.writeText(text);
				copy.textContent = "Copied";
			} catch {
				copy.textContent = "Copy unavailable";
				report("Clipboard access is unavailable. Select and copy the displayed value manually.");
			}
		});
		return copy;
	}
	function openBrowser(url: string, feedback: HTMLElement) {
		if (!safeUrl(url)) return;
		try {
			const opened = window.open(url, "_blank", "noopener,noreferrer");
			feedback.textContent = opened ? "Browser opened. Complete sign-in there, then return here." : "If no browser opened, your browser may have blocked the popup. Use the link below or copy it into a new tab.";
		} catch { feedback.textContent = "The browser could not be opened. Use the link below or copy it into a new tab."; }
	}
	function renderEvents(events: ProviderAuthEvent[]) {
		const signature = JSON.stringify(events);
		if (signature === eventSignature) return;
		eventSignature = signature;
		window.clearInterval(expiryTimer);
		authEvents.replaceChildren();
		const countdowns: { node: HTMLElement; expiry: number }[] = [];
		for (const event of events) {
			const section = node("section", undefined, "provider-auth-event");
			if (event.type === "info") {
				section.append(node("p", event.message));
				for (const item of event.links ?? []) section.append(link(item.url, item.label ?? item.url));
			} else if (event.type === "progress") section.append(node("p", event.message, "providers-footnote"));
			else if (event.type === "auth_url") {
				section.append(node("p", event.instructions ?? "Waiting for authentication…"));
				const feedback = node("p", undefined, "providers-footnote");
				feedback.setAttribute("role", "status");
				if (safeUrl(event.url)) {
					section.append(link(event.url, event.url));
					const actions = node("div", undefined, "button-row");
					actions.append(button("Open browser again", () => openBrowser(event.url, feedback)), copyButton(event.url, "Copy authentication link"));
					section.append(actions, feedback);
					if (!openedUrls.has(event.url)) { openedUrls.add(event.url); openBrowser(event.url, feedback); }
				} else section.append(link(event.url, event.url));
			} else {
				section.append(node("p", "Enter this code on the provider page", "providers-footnote"), node("code", event.userCode, "provider-device-code"), copyButton(event.userCode, "Copy device code"), link(event.verificationUri, event.verificationUri));
				if (event.expiresAt && Number.isFinite(Date.parse(event.expiresAt))) {
					const timer = node("p", undefined, "provider-device-expiry");
					countdowns.push({ node: timer, expiry: Date.parse(event.expiresAt) });
					section.append(timer);
				}
				section.append(node("p", "Waiting for device-code confirmation. Pi handles provider polling.", "providers-footnote"));
			}
			authEvents.append(section);
		}
		function tick() {
			for (const item of countdowns) {
				const seconds = Math.max(0, Math.ceil((item.expiry - Date.now()) / 1000));
				item.node.textContent = seconds ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Code expiry reached. Waiting for Pi’s authentication result.";
			}
		}
		if (countdowns.length) { tick(); expiryTimer = window.setInterval(tick, 1000); }
	}
	function renderPrompt(prompt: ProviderAuthPrompt) {
		const form = node("form", undefined, "provider-auth-prompt");
		form.dataset.promptId = prompt.id;
		form.autocomplete = "off";
		const label = node("label", prompt.message);
		const control = prompt.type === "select" ? node("select") : node("input");
		control.id = `provider-prompt-${prompt.id}`;
		label.htmlFor = control.id;
		control.required = true;
		if (prompt.type === "select") {
			for (const choice of prompt.options) {
				const option = node("option", choice.description ? `${choice.label} — ${choice.description}` : choice.label);
				option.value = choice.id;
				control.append(option);
			}
		} else {
			const input = control as HTMLInputElement;
			input.type = prompt.type === "text" ? "text" : "password";
			input.autocomplete = "off";
			input.spellcheck = false;
			input.setAttribute("autocapitalize", "none");
			input.setAttribute("data-1p-ignore", "true");
			input.setAttribute("data-lpignore", "true");
			input.setAttribute("data-bwignore", "true");
			input.placeholder = prompt.placeholder ?? "";
		}
		const submit = node("button", "Continue", "button button-primary");
		submit.type = "submit";
		form.append(label, control, submit);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (!operation || operation.done || !control.value || submit.disabled) return;
			const id = operation.id;
			const token = generation;
			++responseRevision;
			// The answer exists only in this outgoing request, never retained controller state.
			const request = options.request<ProviderAuthOperation>(`/api/provider-auth/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ promptId: prompt.id, value: control.value }) });
			control.value = "";
			control.disabled = true;
			submit.disabled = true;
			window.clearTimeout(pollTimer);
			void request.then((result) => {
				if (current(token) && operation?.id === id && !cancelling && !operation.done) updateOperation(result);
			}).catch(() => {
				if (!current(token) || operation?.id !== id || cancelling || operation.done) return;
				control.disabled = false;
				submit.disabled = false;
				report("The response could not be submitted. If Pi still requests it, enter it again.");
				schedulePoll();
			});
		});
		prompts.set(prompt.id, { form, control });
		authPrompts.append(form);
	}
	function updateOperation(result: ProviderAuthOperation) {
		operation = result;
		authStatus.textContent = `${connectionLabels[result.state]}${result.message ? ` · ${result.message}` : ""}`;
		authStatus.dataset.state = result.state;
		for (const [id, item] of prompts) {
			if (!result.prompts.some((prompt) => prompt.id === id) || result.done) {
				item.control.value = "";
				item.form.remove();
				prompts.delete(id);
			}
		}
		if (!result.done) {
			renderEvents(result.events);
			for (const prompt of result.prompts) if (!prompts.has(prompt.id)) renderPrompt(prompt);
			schedulePoll();
			return;
		}
		clearTimers();
		authEvents.replaceChildren();
		openedUrls.clear();
		eventSignature = "";
		authActions.replaceChildren();
		if (result.state === "connected" || result.state === "offline_cached" || result.state === "environment") {
			const token = generation;
			void changed().then(() => { if (current(token)) void loadModels(result.providerId); });
		} else {
			authActions.append(button("Back to connection", () => void loadProviders(result.providerId)));
			void changed();
		}
	}
	function schedulePoll() {
		window.clearTimeout(pollTimer);
		if (!operation || operation.done || cancelling) return;
		pollTimer = window.setTimeout(() => void poll(), 750);
	}
	async function poll() {
		if (!operation || operation.done || cancelling) return;
		const id = operation.id;
		const token = generation;
		const revision = responseRevision;
		try {
			const result = await options.request<ProviderAuthOperation>(`/api/provider-auth/${encodeURIComponent(id)}`, { signal: operationAbort?.signal });
			if (current(token) && operation?.id === id && revision === responseRevision && !cancelling && !operation.done) updateOperation(result);
		} catch {
			if (!current(token) || operation?.id !== id || revision !== responseRevision || cancelling || operation.done) return;
			report("Authentication status could not be refreshed. Check the local connection, then retry or cancel.");
			authActions.replaceChildren(button("Retry status", () => { report(""); void poll(); }), button("Cancel authentication", () => void cancelAuth()));
		}
	}
	async function cancelAuth() {
		if (cancelling) return false;
		clearPrompts();
		authPrompts.replaceChildren();
		clearTimers();
		operationAbort?.abort();
		++responseRevision;
		if (starting) {
			++generation;
			authStatus.textContent = "Authentication cancelled. Any pending start will be cancelled when it returns.";
			authActions.replaceChildren(button("Back to providers", () => void loadProviders()));
			return true;
		}
		if (!operation || operation.done) return true;
		cancelling = true;
		const id = operation.id;
		const token = generation;
		authStatus.textContent = "Cancelling authentication…";
		try {
			const result = await options.request<ProviderAuthOperation>(`/api/provider-auth/${encodeURIComponent(id)}`, { method: "DELETE" });
			cancelling = false;
			if (current(token)) updateOperation(result);
			return true;
		} catch {
			cancelling = false;
			if (!current(token)) return false;
			report("Cancellation could not be confirmed. Retry cancellation before closing this window.");
			authActions.replaceChildren(button("Retry cancellation", () => void cancelAuth()));
			return false;
		}
	}

	async function loadModels(providerId: string | null) {
		if (!show() || starting || (operation && !operation.done)) return;
		const token = ++generation;
		screen(providerId && provider ? `Models for ${provider.name}` : "Choose a model", providerId ? 4 : null);
		loading("Loading available Pi models and the active session…");
		try {
			const [available, state, providers] = await Promise.all([
				options.request<{ models: ProviderModel[]; guidance: string }>("/api/chat/models"),
				options.getModelState(),
				options.request<ProviderCatalog>("/api/providers"),
			]);
			if (!current(token)) return;
			catalog = providers;
			renderModels(available.models, available.guidance, state, providerId);
		} catch {
			if (!current(token)) return;
			body.replaceChildren(button("Try again", () => void loadModels(providerId)), button("Manage providers", () => void loadProviders()));
			report("Available models or the active session could not be loaded. Try again.");
		}
	}
	function modelName(model: ProviderModel) {
		return model.virtual && model.provider === "router" && model.id === "auto" ? "Auto — Pi chooses" : model.name;
	}
	function renderModels(models: ProviderModel[], guidance: string, state: SessionModelState, providerId: string | null) {
		body.replaceChildren();
		const names = new Map(catalog?.providers.map((item) => [item.id, item.name]));
		const currentModel = node("p", state.model ? `Current session: ${modelName(state.model)} · ${state.thinkingLevel} thinking` : "No model selected for this session.", "providers-intro");
		const search = node("input");
		search.type = "search";
		search.placeholder = "Search models, providers or capabilities";
		search.setAttribute("aria-label", "Search models");
		const providerFilter = node("select");
		providerFilter.setAttribute("aria-label", "Filter models by provider");
		const all = node("option", "All available providers");
		all.value = "";
		providerFilter.append(all);
		for (const id of new Set(models.map((model) => model.provider))) {
			const option = node("option", names.get(id) ?? id);
			option.value = id;
			providerFilter.append(option);
		}
		providerFilter.value = providerId ?? "";
		const filters = node("div", undefined, "provider-model-filters");
		filters.append(search, providerFilter);
		const list = node("fieldset", undefined, "provider-model-list");
		list.append(node("legend", "Available models"));
		const rows = node("div");
		list.append(rows);
		const empty = node("div", undefined, "providers-empty");
		empty.append(node("p", "No available models match. Change the filters or connect a provider."), button("Manage providers", () => void loadProviders()));
		const form = node("form", undefined, "provider-model-form");
		const thinking = node("select");
		thinking.setAttribute("aria-label", "Thinking level");
		const thinkingLabel = node("label", "Thinking level");
		thinkingLabel.append(thinking);
		const persist = node("input");
		persist.type = "checkbox";
		const persistLabel = node("label", undefined, "provider-default-control");
		persistLabel.append(persist, node("span", "Use as default for new sessions"));
		const disclosure = node("p", "Choose a model to review its recipient before applying.", "provider-model-disclosure");
		const submit = node("button", "Use model", "button button-primary");
		submit.type = "submit";
		submit.disabled = true;
		const modelRows: { model: ProviderModel; row: HTMLElement; radio: HTMLInputElement }[] = [];
		let selecting = false;
		function candidate(model: ProviderModel) {
			thinking.replaceChildren();
			for (const level of model.thinkingLevels) {
				const option = node("option", level);
				option.value = level;
				thinking.append(option);
			}
			if (model.thinkingLevels.includes(state.thinkingLevel)) thinking.value = state.thinkingLevel;
			thinking.disabled = !model.thinkingLevels.length;
			disclosure.textContent = model.virtual
				? `Auto may send future messages and existing approved history to any available configured provider: ${[...new Set(models.filter((item) => !item.virtual).map((item) => names.get(item.provider) ?? item.provider))].join(", ") || "none currently available"}. Selection does not send a message.`
				: `Future messages may disclose existing approved history to ${names.get(model.provider) ?? model.provider}. Selection does not send a message.`;
			submit.disabled = selecting;
		}
		function metric(label: string, value: string, details: HTMLElement) { details.append(node("dt", label), node("dd", value)); }
		for (const model of models) {
			const row = node("label", undefined, "provider-model-row");
			const radio = node("input");
			radio.type = "radio";
			radio.name = "provider-model";
			radio.setAttribute("aria-label", `${modelName(model)} — ${names.get(model.provider) ?? model.provider}`);
			radio.addEventListener("change", () => candidate(model));
			const copy = node("div", undefined, "provider-model-copy");
			const title = node("div", undefined, "provider-model-title");
			title.append(node("strong", modelName(model)), node("span", model.billing === "subscription" ? "Subscription" : model.billing === "virtual" ? "Pi routing" : "API billing", "provider-badge"));
			copy.append(title, node("p", `${names.get(model.provider) ?? model.provider} · ${model.id}`, "provider-meta"));
			const details = node("dl", undefined, "provider-model-details");
			metric("Context", model.contextWindow > 0 ? `${model.contextWindow.toLocaleString()} tokens` : "Not specified", details);
			metric("Max output", model.maxTokens > 0 ? `${model.maxTokens.toLocaleString()} tokens` : "Not specified", details);
			metric("Input", model.input.join(" + "), details);
			metric("Reasoning", model.reasoning ? "Supported" : "Not supported", details);
			metric("Thinking", model.thinkingLevels.join(", ") || "Not specified", details);
			metric("Price / 1M tokens", model.virtual ? "Depends on routed model" : `$${model.cost.input} input · $${model.cost.output} output`, details);
			copy.append(details);
			row.append(radio, copy);
			rows.append(row);
			modelRows.push({ model, row, radio });
			if (state.model?.provider === model.provider && state.model.id === model.id) { radio.checked = true; candidate(model); }
		}
		function filter() {
			const query = search.value.trim().toLocaleLowerCase();
			let count = 0;
			for (const item of modelRows) {
				const { model } = item;
				item.row.hidden = Boolean(providerFilter.value && model.provider !== providerFilter.value) || !`${model.name} ${model.id} ${model.provider} ${names.get(model.provider) ?? ""} ${model.input.join(" ")} ${model.reasoning ? "reasoning" : ""} ${model.thinkingLevels.join(" ")}`.toLocaleLowerCase().includes(query);
				if (!item.row.hidden) count++;
			}
			empty.hidden = count > 0;
			list.hidden = !count;
		}
		search.addEventListener("input", filter);
		providerFilter.addEventListener("change", filter);
		filter();
		const controls = node("div", undefined, "provider-model-controls");
		controls.append(thinkingLabel, persistLabel);
		form.append(list, empty, controls, disclosure, submit);
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const selected = modelRows.find((item) => item.radio.checked);
			if (!selected || submit.disabled || selecting) return;
			const token = generation;
			selecting = true;
			submit.disabled = true;
			submit.textContent = "Applying to session…";
			report("");
			try {
				const result = await options.onSelectModel({ provider: selected.model.provider, modelId: selected.model.id, thinkingLevel: (thinking.value || "off") as ModelThinkingLevel, persist: persist.checked });
				if (!current(token)) return;
				screen("Ready to continue", providerId ? 5 : null);
				body.append(node("p", result.model ? `Selected ${modelName(result.model)} · ${names.get(result.model.provider) ?? result.model.provider} · ${result.thinkingLevel} thinking` : "Pi reports no selected model.", "providers-intro"), node("p", "The active Pi session is updated. No message has been sent.", "providers-footnote"), button("Done", () => void close(), true), button("Choose another model", () => void loadModels(providerId)));
			} catch {
				if (!current(token)) return;
				selecting = false;
				submit.disabled = false;
				submit.textContent = "Use model";
				report("The session model could not be changed. Reopen the picker to check the authoritative selection before retrying.");
			}
		});
		body.append(currentModel, filters, form, node("p", guidance, "providers-footnote"));
	}
	function finishClose() {
		++generation;
		clearTimers();
		clearPrompts();
		operationAbort?.abort();
		operation = null;
		openedUrls.clear();
		eventSignature = "";
		body.replaceChildren();
		authEvents.replaceChildren();
		authPrompts.replaceChildren();
		if (dialog.open) dialog.close();
		if (previousFocus?.isConnected) previousFocus.focus();
		previousFocus = null;
	}
	async function close() { if (await cancelAuth()) finishClose(); }
	dialog.addEventListener("cancel", (event) => { event.preventDefault(); void close(); });
	dialog.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Escape") { event.preventDefault(); void close(); }
		else if (event.key === "Tab") {
			const focusable = [...dialog.querySelectorAll<HTMLElement>("button, input, select, a[href], [tabindex='0']")].filter((item) => !item.closest("[hidden]") && !item.hasAttribute("disabled"));
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && (document.activeElement === first || document.activeElement === heading)) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		}
	});
	return {
		open: (providerId) => { void loadProviders(providerId); },
		openModelPicker: () => { void loadModels(null); },
		close: () => { void close(); },
		dispose() {
			if (disposed) return;
			if (operation && !operation.done) void options.request(`/api/provider-auth/${encodeURIComponent(operation.id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
			disposed = true;
			finishClose();
			dialog.remove();
		},
	};
}
