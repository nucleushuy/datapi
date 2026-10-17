export type CenterTab = "data" | "code" | "visualize" | "statistics" | "models";
export type RightTab = "assistant" | "activity";
export type Destination = "chat" | "data" | "tools" | "settings";
type Theme = "dark" | "light";

export interface ShellController {
	selectCenter(tab: CenterTab, focus?: boolean): void;
	selectRight(tab: RightTab, focus?: boolean): void;
	navigate(destination: Destination, focus?: boolean): void;
	toggleSidebar(): void;
	setLoading(loading: boolean): void;
	setDatasetAvailable(available: boolean): void;
	showError(): void;
	dispose(): void;
}

export interface AppKeybinding {
	key: string;
	ctrl?: boolean;
	meta?: boolean;
	alt?: boolean;
	shift?: boolean;
}

export interface AppKeybindings {
	commandPalette: readonly AppKeybinding[];
	toggleSidebar: readonly AppKeybinding[];
	sendMessage: readonly AppKeybinding[];
	newline: readonly AppKeybinding[];
}

export interface ShellOptions {
	keybindings?: Partial<AppKeybindings>;
}

export const DEFAULT_APP_KEYBINDINGS: AppKeybindings = {
	commandPalette: [
		{ key: "k", ctrl: true },
		{ key: "k", meta: true },
	],
	toggleSidebar: [
		{ key: "b", ctrl: true },
		{ key: "b", meta: true },
	],
	sendMessage: [{ key: "Enter" }],
	newline: [{ key: "Enter", shift: true }],
};

export function matchesAppKeybinding(event: KeyboardEvent, binding: AppKeybinding): boolean {
	return (
		event.key.toLowerCase() === binding.key.toLowerCase() &&
		Boolean(event.ctrlKey) === Boolean(binding.ctrl) &&
		Boolean(event.metaKey) === Boolean(binding.meta) &&
		Boolean(event.altKey) === Boolean(binding.alt) &&
		Boolean(event.shiftKey) === Boolean(binding.shift)
	);
}

export const SHELL_STORAGE_KEY = "datapi.workbench.shell.v1";
const CENTER_TABS: readonly CenterTab[] = ["data", "code", "visualize", "statistics", "models"];
const RIGHT_TABS: readonly RightTab[] = ["assistant", "activity"];
const LEFT_MIN = 180;
const LEFT_MAX = 400;
const RIGHT_MIN = 240;
const RIGHT_MAX = 500;
const CENTER_MIN = 320;
const SPLITTER_WIDTH = 6;

interface ShellPreferences {
	version: 2;
	leftWidth: number;
	rightWidth: number;
	centerTab: CenterTab;
	rightTab: RightTab;
	theme: Theme;
	sidebarCollapsed: boolean;
}

const DEFAULT_PREFERENCES: Readonly<ShellPreferences> = {
	version: 2,
	leftWidth: 240,
	rightWidth: 300,
	centerTab: "data",
	rightTab: "assistant",
	theme: "dark",
	sidebarCollapsed: false,
};

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.round(Math.max(minimum, Math.min(value, maximum)));
}

function restorePreferences(value: unknown): ShellPreferences {
	if (typeof value !== "object" || value === null || !("version" in value)) return { ...DEFAULT_PREFERENCES };
	const isLegacy = value.version === 1;
	if (!isLegacy && value.version !== 2) return { ...DEFAULT_PREFERENCES };
	return {
		version: 2,
		leftWidth:
			"leftWidth" in value && typeof value.leftWidth === "number" && Number.isFinite(value.leftWidth)
				? clamp(value.leftWidth, LEFT_MIN, LEFT_MAX)
				: DEFAULT_PREFERENCES.leftWidth,
		rightWidth:
			"rightWidth" in value && typeof value.rightWidth === "number" && Number.isFinite(value.rightWidth)
				? clamp(value.rightWidth, RIGHT_MIN, RIGHT_MAX)
				: DEFAULT_PREFERENCES.rightWidth,
		centerTab:
			!isLegacy && "centerTab" in value && CENTER_TABS.some((tab) => tab === value.centerTab)
				? (value.centerTab as CenterTab)
				: DEFAULT_PREFERENCES.centerTab,
		rightTab:
			"rightTab" in value && RIGHT_TABS.some((tab) => tab === value.rightTab)
				? (value.rightTab as RightTab)
				: DEFAULT_PREFERENCES.rightTab,
		theme: "theme" in value && value.theme === "light" ? "light" : "dark",
		sidebarCollapsed: "sidebarCollapsed" in value && value.sidebarCollapsed === true,
	};
}

interface PaletteCommand {
	id: string;
	label: string;
	run(): void;
}

interface ResizeDrag {
	side: "left" | "right";
	pointerId: number;
	startX: number;
	startWidth: number;
	previousWidth: number;
	splitter: HTMLElement;
}

/** The supplied DOM owns all effects, allowing independent workbenches and DOM tests. */
export function initializeShell(document: Document, window: Window, options: ShellOptions = {}): ShellController {
	function element<T extends HTMLElement>(id: string): T {
		const result = document.getElementById(id);
		if (!result) throw new Error(`Missing interface element: ${id}`);
		return result as T;
	}

	const layout = element("shell-layout");
	const workspace = element("workspace");
	const leftSplitter = element("left-splitter");
	const rightSplitter = element("right-splitter");
	const loading = element("shell-loading");
	const error = element("shell-error");
	const storageNote = element("shell-storage-note");
	const statisticsContent = element("shell-statistics-content");
	const statisticsEmpty = element("shell-statistics-empty");
	const themeToggle = element<HTMLButtonElement>("theme-toggle");
	const resetButton = element<HTMLButtonElement>("reset-layout");
	const reloadButton = element<HTMLButtonElement>("shell-reload");
	const commandTrigger = element<HTMLButtonElement>("command-trigger");
	const dialog = element<HTMLDialogElement>("command-dialog");
	const search = element<HTMLInputElement>("command-search");
	const results = element<HTMLUListElement>("command-results");
	const emptyCommands = element("command-empty");
	const closeButton = element<HTMLButtonElement>("command-close");
	const chatWorkspace = element("chat-workspace");
	const sessionSidebar = element("session-sidebar");
	const sidebarClose = element<HTMLButtonElement>("sidebar-close");
	const sidebarBackdrop = element<HTMLButtonElement>("sidebar-backdrop");
	const sessionsButton = element<HTMLButtonElement>("rail-sessions");
	const operation = element("operation");
	const operationLink = element<HTMLButtonElement>("shell-operation-link");
	const operationHome = document.createComment("Local operation position");
	operation.before(operationHome);
	const destinations = {
		chat: element("chat-destination"),
		data: element("data-destination"),
		tools: element("tools-destination"),
		settings: element("settings-destination"),
	};
	const destinationButtons: readonly [string, Destination][] = [
		["rail-sessions", "chat"],
		["rail-files", "data"],
		["rail-data", "data"],
		["rail-tools", "tools"],
		["rail-settings", "settings"],
	];
	const compact = window.matchMedia("(max-width: 1099px)");
	const stacked = window.matchMedia("(max-width: 699px)");
	const keybindings: AppKeybindings = { ...DEFAULT_APP_KEYBINDINGS, ...options.keybindings };
	const cleanup: (() => void)[] = [];
	let disposed = false;
	let preferences = { ...DEFAULT_PREFERENCES };
	let drag: ResizeDrag | null = null;
	let leftWidth = preferences.leftWidth;
	let rightWidth = preferences.rightWidth;
	let leftMaximum = LEFT_MAX;
	let rightMaximum = RIGHT_MAX;
	let previousFocus: HTMLElement | null = null;
	let selectedCommand = -1;
	let filteredCommands: PaletteCommand[] = [];
	let commandOptions: HTMLLIElement[] = [];
	let destination: Destination = "chat";
	let mobileSidebarOpen = false;
	let sidebarReturnFocus: HTMLElement | null = null;
	let wasMobile = stacked.matches;

	function listen<E extends Event>(target: EventTarget, type: string, handler: (event: E) => void): void {
		const listener = handler as EventListener;
		target.addEventListener(type, listener);
		cleanup.push(() => target.removeEventListener(type, listener));
	}

	function storageUnavailable(): void {
		storageNote.textContent =
			"Layout preferences could not be saved or restored in this browser. You can keep working; your local datasets are unaffected.";
		storageNote.hidden = false;
	}

	try {
		const saved = window.localStorage.getItem(SHELL_STORAGE_KEY);
		if (saved !== null) preferences = restorePreferences(JSON.parse(saved));
	} catch {
		storageUnavailable();
	}

	function persist(): void {
		try {
			window.localStorage.setItem(SHELL_STORAGE_KEY, JSON.stringify(preferences));
		} catch {
			storageUnavailable();
		}
	}

	function emit(type: string): void {
		const event = document.createEvent("CustomEvent");
		event.initCustomEvent(type, true, false, undefined);
		document.dispatchEvent(event);
	}

	function applySidebar(): void {
		const open = destination === "chat" && (stacked.matches ? mobileSidebarOpen : !preferences.sidebarCollapsed);
		const focused = document.activeElement;
		sessionSidebar.hidden = !open;
		destinations.chat.dataset.sidebar = open ? "open" : "closed";
		sessionsButton.setAttribute("aria-expanded", String(open));
		sidebarBackdrop.hidden = !(open && stacked.matches);
		chatWorkspace.inert = open && stacked.matches;
		if (stacked.matches && open) {
			sessionSidebar.setAttribute("role", "dialog");
			sessionSidebar.setAttribute("aria-modal", "true");
		} else {
			sessionSidebar.removeAttribute("role");
			sessionSidebar.removeAttribute("aria-modal");
		}
		if (!open && focused && sessionSidebar.contains(focused)) sessionsButton.focus();
	}

	function setSidebar(open: boolean, focus = true): void {
		if (disposed) return;
		if (stacked.matches) {
			mobileSidebarOpen = open;
			if (open) sidebarReturnFocus = document.activeElement as HTMLElement | null;
		} else {
			preferences.sidebarCollapsed = !open;
			persist();
		}
		applySidebar();
		if (open && focus) sidebarClose.focus();
		else if (!open && focus) {
			(sidebarReturnFocus?.isConnected ? sidebarReturnFocus : sessionsButton).focus();
			sidebarReturnFocus = null;
		}
	}

	function navigate(next: Destination, focus = true): void {
		if (disposed || !Object.hasOwn(destinations, next)) return;
		finishDrag(false);
		destination = next;
		document.body.dataset.destination = next;
		mobileSidebarOpen = false;
		for (const [name, panel] of Object.entries(destinations)) panel.hidden = name !== next;
		for (const [id, target] of destinationButtons) {
			const button = element(id);
			const active = target === next;
			button.classList.toggle("rail-button-active", active);
			if (active) button.setAttribute("aria-current", "page");
			else button.removeAttribute("aria-current");
		}
		if (next === "tools") element("tools-operation-host").append(operation);
		else operationHome.after(operation);
		const skip = document.querySelector<HTMLAnchorElement>(".skip-link");
		if (skip)
			skip.href = next === "chat" ? "#chat-workspace" : next === "data" ? "#workspace" : `#${next}-destination`;
		applyLayout();
		if (focus) (next === "chat" ? chatWorkspace : next === "data" ? workspace : destinations[next]).focus();
		if (next === "settings") emit("workbench:open-settings");
	}

	function toggleSidebar(): void {
		if (destination !== "chat") {
			navigate("chat", false);
			setSidebar(true);
		} else setSidebar(sessionSidebar.hidden);
	}

	function newSession(): void {
		navigate("chat");
		emit("workbench:new-session");
	}

	function openChatPanel(type: "tools"): void {
		navigate("chat");
		emit(`workbench:open-${type}`);
	}

	for (const [id, target] of destinationButtons) {
		if (id === "rail-sessions") continue;
		listen(element(id), "click", () => {
			navigate(target);
			if (id === "rail-files") element("datasets-label").scrollIntoView?.({ block: "nearest" });
		});
	}
	listen(sessionsButton, "click", toggleSidebar);
	listen(sidebarClose, "click", () => setSidebar(false));
	listen(sidebarBackdrop, "click", () => setSidebar(false));
	listen(element("rail-new-session"), "click", newSession);
	for (const id of ["rail-home", "data-back-chat", "tools-back-chat", "settings-back-chat", "inspector-open-chat"]) {
		listen(element(id), "click", () => navigate("chat"));
	}
	for (const id of ["session-project", "tools-open-data"]) listen(element(id), "click", () => navigate("data"));
	listen(element("inspector-open-tools"), "click", () => navigate("tools"));
	listen(element("tools-review-chat"), "click", () => openChatPanel("tools"));
	listen(element("settings-provider"), "click", () => emit("workbench:open-settings"));
	listen(operationLink, "click", () => navigate("tools"));
	listen<CustomEvent<Destination>>(document, "workbench:navigate", (event) => navigate(event.detail));
	listen<MouseEvent>(sessionSidebar, "click", (event) => {
		const target = event.target as HTMLElement | null;
		if (stacked.matches && target?.closest(".chat-session-select:not(:disabled), #conversation-new:not(:disabled)")) {
			setSidebar(false, false);
			chatWorkspace.focus();
		}
	});
	listen<KeyboardEvent>(document, "keydown", (event) => {
		if (!stacked.matches || !mobileSidebarOpen || dialog.open || event.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			setSidebar(false);
		} else if (event.key === "Tab") {
			const focusable = [
				...sessionSidebar.querySelectorAll<HTMLElement>(
					"button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex='0']",
				),
			].filter(
				(item) => !item.closest("[hidden]") && (!item.closest("details:not([open])") || item.tagName === "SUMMARY"),
			);
			const first = focusable[0] ?? sessionSidebar;
			const last = focusable.at(-1) ?? sessionSidebar;
			if (event.shiftKey && (document.activeElement === first || !sessionSidebar.contains(document.activeElement))) {
				event.preventDefault();
				last.focus();
			} else if (
				!event.shiftKey &&
				(document.activeElement === last || !sessionSidebar.contains(document.activeElement))
			) {
				event.preventDefault();
				first.focus();
			}
		}
	});
	const projectSelect = element<HTMLSelectElement>("project-select");
	function updateProjectLabel(): void {
		element("session-project-label").textContent =
			projectSelect.selectedOptions[0]?.textContent || "Choose a project";
	}
	function updateOperationStatus(): void {
		element("tools-operation-empty").hidden = !operation.hidden;
		operationLink.hidden = operation.hidden;
		operationLink.textContent = `Local operation · ${operation.dataset.state || "view activity"}`;
	}
	const Observer = document.defaultView?.MutationObserver;
	if (Observer) {
		const projectObserver = new Observer(updateProjectLabel);
		projectObserver.observe(projectSelect, { subtree: true, childList: true, characterData: true, attributes: true });
		projectObserver.observe(element("project-heading"), { childList: true, characterData: true, subtree: true });
		const operationObserver = new Observer(updateOperationStatus);
		operationObserver.observe(operation, { attributes: true, attributeFilter: ["hidden", "data-state"] });
		cleanup.push(
			() => projectObserver.disconnect(),
			() => operationObserver.disconnect(),
		);
	}
	listen(projectSelect, "change", updateProjectLabel);
	updateProjectLabel();
	updateOperationStatus();

	function applyLayout(): void {
		const width = layout.getBoundingClientRect().width || layout.clientWidth || window.innerWidth - 52;
		const isStacked = stacked.matches;
		const isCompact = compact.matches;
		if (wasMobile !== isStacked) {
			mobileSidebarOpen = false;
			wasMobile = isStacked;
		}
		applySidebar();
		leftWidth = clamp(preferences.leftWidth, LEFT_MIN, LEFT_MAX);
		rightWidth = clamp(preferences.rightWidth, RIGHT_MIN, RIGHT_MAX);
		if (!isStacked) {
			const available = width - CENTER_MIN - SPLITTER_WIDTH * (isCompact ? 1 : 2);
			leftWidth = clamp(leftWidth, LEFT_MIN, Math.min(LEFT_MAX, available - (isCompact ? 0 : RIGHT_MIN)));
			if (!isCompact) rightWidth = clamp(rightWidth, RIGHT_MIN, Math.min(RIGHT_MAX, available - leftWidth));
			leftMaximum = Math.max(LEFT_MIN, Math.min(LEFT_MAX, available - (isCompact ? 0 : rightWidth)));
			rightMaximum = isCompact ? RIGHT_MAX : Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, available - leftWidth));
		} else {
			leftMaximum = LEFT_MAX;
			rightMaximum = RIGHT_MAX;
		}
		// Only rendered widths change on a smaller viewport; desktop preferences remain intact.
		layout.style.setProperty("--left-panel-width", `${leftWidth}px`);
		layout.style.setProperty("--right-panel-width", `${rightWidth}px`);
		leftSplitter.hidden = destination !== "data" || isStacked;
		rightSplitter.hidden = destination !== "data" || isCompact;
		for (const [splitter, minimum, maximum, current] of [
			[leftSplitter, LEFT_MIN, leftMaximum, leftWidth],
			[rightSplitter, RIGHT_MIN, rightMaximum, rightWidth],
		] as const) {
			splitter.tabIndex = splitter.hidden ? -1 : 0;
			splitter.setAttribute("aria-valuemin", String(minimum));
			splitter.setAttribute("aria-valuemax", String(maximum));
			splitter.setAttribute("aria-valuenow", String(current));
			splitter.setAttribute("aria-valuetext", `${current} pixels`);
		}
	}

	function finishDrag(commit: boolean): void {
		if (!drag) return;
		const current = drag;
		drag = null;
		delete layout.dataset.resizing;
		if (!commit) {
			if (current.side === "left") preferences.leftWidth = current.previousWidth;
			else preferences.rightWidth = current.previousWidth;
		}
		if (current.splitter.hasPointerCapture?.(current.pointerId)) {
			current.splitter.releasePointerCapture(current.pointerId);
		}
		applyLayout();
		if (commit) persist();
	}

	for (const [side, splitter, controls, label] of [
		["left", leftSplitter, "projects-panel", "Resize project panel"],
		["right", rightSplitter, "inspector-panel", "Resize assistant panel"],
	] as const) {
		splitter.setAttribute("role", "separator");
		splitter.setAttribute("aria-orientation", "vertical");
		splitter.setAttribute("aria-controls", controls);
		splitter.setAttribute("aria-label", label);
		listen<PointerEvent>(splitter, "pointerdown", (event) => {
			if (event.button !== 0 || drag || splitter.hidden) return;
			event.preventDefault();
			splitter.focus({ preventScroll: true });
			drag = {
				side,
				pointerId: event.pointerId,
				startX: event.clientX,
				startWidth: side === "left" ? leftWidth : rightWidth,
				previousWidth: side === "left" ? preferences.leftWidth : preferences.rightWidth,
				splitter,
			};
			layout.dataset.resizing = side;
			try {
				splitter.setPointerCapture?.(event.pointerId);
			} catch {
				// Window listeners still complete the drag if capture is unavailable.
			}
		});
		listen<PointerEvent>(splitter, "lostpointercapture", (event) => {
			if (drag?.pointerId === event.pointerId) finishDrag(true);
		});
		listen<KeyboardEvent>(splitter, "keydown", (event) => {
			if (splitter.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
			const current = side === "left" ? leftWidth : rightWidth;
			const minimum = side === "left" ? LEFT_MIN : RIGHT_MIN;
			const maximum = side === "left" ? leftMaximum : rightMaximum;
			const step = event.shiftKey ? 40 : 10;
			let next: number;
			switch (event.key) {
				case "ArrowLeft":
					next = current + (side === "left" ? -step : step);
					break;
				case "ArrowRight":
					next = current + (side === "left" ? step : -step);
					break;
				case "Home":
					next = minimum;
					break;
				case "End":
					next = maximum;
					break;
				default:
					return;
			}
			event.preventDefault();
			finishDrag(false);
			if (side === "left") preferences.leftWidth = clamp(next, minimum, maximum);
			else preferences.rightWidth = clamp(next, minimum, maximum);
			applyLayout();
			persist();
		});
	}

	listen<PointerEvent>(window, "pointermove", (event) => {
		if (!drag || event.pointerId !== drag.pointerId) return;
		event.preventDefault();
		const delta = event.clientX - drag.startX;
		if (drag.side === "left") preferences.leftWidth = clamp(drag.startWidth + delta, LEFT_MIN, leftMaximum);
		else preferences.rightWidth = clamp(drag.startWidth - delta, RIGHT_MIN, rightMaximum);
		applyLayout();
	});
	listen<PointerEvent>(window, "pointerup", (event) => {
		if (drag?.pointerId === event.pointerId) finishDrag(true);
	});
	listen<PointerEvent>(window, "pointercancel", (event) => {
		if (drag?.pointerId === event.pointerId) finishDrag(false);
	});
	listen(window, "blur", () => finishDrag(false));
	for (const [target, event] of [
		[window, "resize"],
		[compact, "change"],
		[stacked, "change"],
	] as const) {
		listen(target, event, () => {
			finishDrag(false);
			applyLayout();
		});
	}

	function tabGroup<T extends string>(
		prefix: "center" | "right",
		values: readonly T[],
		initial: T,
		onChange: (tab: T) => void,
	): (tab: T, focus?: boolean) => void {
		const tabs = values.map((tab) => ({
			value: tab,
			button: element<HTMLButtonElement>(`${prefix}-tab-${tab}`),
			panel: element(`${prefix}-panel-${tab}`),
		}));
		function select(value: T, focus = false): void {
			if (disposed || !values.includes(value)) return;
			for (const tab of tabs) {
				const selected = tab.value === value;
				tab.button.setAttribute("aria-selected", String(selected));
				tab.button.tabIndex = selected ? 0 : -1;
				tab.panel.hidden = !selected;
				if (selected && focus) tab.button.focus();
			}
			onChange(value);
		}
		for (const [index, tab] of tabs.entries()) {
			listen(tab.button, "click", () => select(tab.value));
			listen<KeyboardEvent>(tab.button, "keydown", (event) => {
				if (event.altKey || event.ctrlKey || event.metaKey) return;
				let next: number;
				switch (event.key) {
					case "ArrowLeft":
						next = (index + tabs.length - 1) % tabs.length;
						break;
					case "ArrowRight":
						next = (index + 1) % tabs.length;
						break;
					case "Home":
						next = 0;
						break;
					case "End":
						next = tabs.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				select(tabs[next].value, true);
			});
		}
		select(initial);
		return select;
	}

	const selectCenter = tabGroup("center", CENTER_TABS, preferences.centerTab, (tab) => {
		if (preferences.centerTab === tab) return;
		preferences.centerTab = tab;
		persist();
	});
	const selectRight = tabGroup("right", RIGHT_TABS, preferences.rightTab, (tab) => {
		if (preferences.rightTab === tab) return;
		preferences.rightTab = tab;
		persist();
	});

	function applyTheme(): void {
		document.documentElement.dataset.theme = preferences.theme;
		const nextTheme = preferences.theme === "dark" ? "light" : "dark";
		themeToggle.textContent = `${nextTheme === "light" ? "Light" : "Dark"} theme`;
		themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
	}

	function toggleTheme(): void {
		preferences.theme = preferences.theme === "dark" ? "light" : "dark";
		applyTheme();
		persist();
	}

	function resetLayout(): void {
		finishDrag(false);
		preferences = { ...DEFAULT_PREFERENCES };
		selectCenter(preferences.centerTab);
		selectRight(preferences.rightTab);
		applyTheme();
		applyLayout();
		persist();
		applySidebar();
	}

	const commands: PaletteCommand[] = [
		...CENTER_TABS.map((tab) => ({
			id: `center-${tab}`,
			label: `Show ${tab[0].toUpperCase()}${tab.slice(1)}`,
			run: () => {
				navigate("data", false);
				selectCenter(tab, true);
			},
		})),
		...RIGHT_TABS.map((tab) => ({
			id: `right-${tab}`,
			label: `Show ${tab[0].toUpperCase()}${tab.slice(1)}`,
			run: () => {
				navigate("data", false);
				selectRight(tab, true);
			},
		})),
		{ id: "chat", label: "Open chat workspace", run: () => navigate("chat") },
		{ id: "new-session", label: "New chat session", run: newSession },
		{ id: "sessions", label: "Toggle sessions sidebar", run: toggleSidebar },
		{ id: "tools", label: "Open tools and activity", run: () => navigate("tools") },
		{ id: "settings", label: "Open settings", run: () => navigate("settings") },
		{ id: "theme", label: "Toggle light / dark theme", run: toggleTheme },
		{ id: "reset-layout", label: "Reset layout and preferences", run: resetLayout },
	];

	function setSelectedCommand(index: number): void {
		selectedCommand = index;
		for (const [position, option] of commandOptions.entries()) {
			option.setAttribute("aria-selected", String(position === index));
		}
		const active = commandOptions[index];
		if (active) {
			search.setAttribute("aria-activedescendant", active.id);
			active.scrollIntoView?.({ block: "nearest" });
		} else {
			search.removeAttribute("aria-activedescendant");
		}
	}

	function filterCommands(): void {
		const words = search.value.trim().toLowerCase().split(/\s+/);
		filteredCommands = commands.filter((command) =>
			words.every((word) => command.label.toLowerCase().includes(word)),
		);
		commandOptions = filteredCommands.map((command, index) => {
			const option = document.createElement("li");
			option.id = `command-option-${command.id}`;
			option.setAttribute("role", "option");
			option.dataset.index = String(index);
			option.textContent = command.label;
			return option;
		});
		results.replaceChildren(...commandOptions);
		emptyCommands.hidden = filteredCommands.length > 0;
		results.hidden = filteredCommands.length === 0;
		search.setAttribute("aria-expanded", String(dialog.open && filteredCommands.length > 0));
		setSelectedCommand(filteredCommands.length > 0 ? 0 : -1);
	}

	function restoreFocus(): void {
		if (dialog.open) return;
		search.setAttribute("aria-expanded", "false");
		search.removeAttribute("aria-activedescendant");
		const focus = previousFocus;
		previousFocus = null;
		if (focus?.isConnected) focus.focus();
	}

	function closePalette(): void {
		if (dialog.open) dialog.close();
		restoreFocus();
	}

	function openPalette(): void {
		if (dialog.open) {
			search.focus();
			return;
		}
		previousFocus = document.activeElement as HTMLElement | null;
		search.value = "";
		dialog.showModal();
		filterCommands();
		search.focus();
	}

	function executeCommand(): void {
		const command = filteredCommands[selectedCommand];
		if (!command) return;
		closePalette();
		command.run();
	}

	listen(commandTrigger, "click", openPalette);
	listen(closeButton, "click", closePalette);
	listen(dialog, "close", restoreFocus);
	listen(dialog, "cancel", (event) => {
		event.preventDefault();
		closePalette();
	});
	listen(search, "input", filterCommands);
	listen<KeyboardEvent>(dialog, "keydown", (event) => {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.key === "Tab") {
			if (!event.shiftKey && event.target === search) {
				event.preventDefault();
				closeButton.focus();
			} else if (event.shiftKey && event.target === closeButton) {
				event.preventDefault();
				search.focus();
			}
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closePalette();
			return;
		}
		if (event.target !== search) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (filteredCommands.length === 0) return;
			const direction = event.key === "ArrowDown" ? 1 : -1;
			setSelectedCommand((selectedCommand + direction + filteredCommands.length) % filteredCommands.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			executeCommand();
		}
	});
	listen<PointerEvent>(results, "pointerdown", (event) => event.preventDefault());
	listen<MouseEvent>(results, "click", (event) => {
		const target = event.target as HTMLElement | null;
		const option = target?.closest<HTMLElement>("[role='option']");
		if (!option || option.parentElement !== results) return;
		setSelectedCommand(Number(option.dataset.index));
		executeCommand();
	});
	listen<KeyboardEvent>(document, "keydown", (event) => {
		if (event.defaultPrevented || event.isComposing || event.repeat) return;
		const target = event.target as HTMLElement | null;
		if (typeof target?.closest === "function" && target.closest('[aria-modal="true"]')) return;
		if (keybindings.commandPalette.some((binding) => matchesAppKeybinding(event, binding))) {
			event.preventDefault();
			if (dialog.open) closePalette();
			else openPalette();
		} else if (!dialog.open && keybindings.toggleSidebar.some((binding) => matchesAppKeybinding(event, binding))) {
			event.preventDefault();
			toggleSidebar();
		}
	});
	listen(themeToggle, "click", toggleTheme);
	listen(resetButton, "click", resetLayout);
	listen(reloadButton, "click", () => window.location.reload());

	function setLoading(value: boolean): void {
		if (disposed) return;
		loading.hidden = !value;
		workspace.setAttribute("aria-busy", String(value));
		chatWorkspace.setAttribute("aria-busy", String(value));
	}

	function setDatasetAvailable(available: boolean): void {
		if (disposed) return;
		statisticsContent.hidden = !available;
		statisticsEmpty.hidden = available;
	}

	function showError(): void {
		if (disposed) return;
		// Keep error details out of the DOM: filenames, promises and messages may contain private data.
		setLoading(false);
		error.hidden = false;
	}

	listen(window, "error", showError);
	listen(window, "unhandledrejection", showError);
	applyTheme();
	navigate("chat", false);
	setLoading(!loading.hidden);
	setDatasetAvailable(false);
	search.setAttribute("aria-expanded", "false");
	persist();

	return {
		selectCenter(tab, focus) {
			navigate("data", false);
			selectCenter(tab, focus);
		},
		selectRight(tab, focus) {
			navigate("data", false);
			selectRight(tab, focus);
		},
		navigate,
		toggleSidebar,
		setLoading,
		setDatasetAvailable,
		showError,
		dispose() {
			if (disposed) return;
			finishDrag(false);
			closePalette();
			mobileSidebarOpen = false;
			chatWorkspace.inert = false;
			operationHome.after(operation);
			operationHome.remove();
			sessionSidebar.removeAttribute("aria-modal");
			sessionSidebar.removeAttribute("role");
			disposed = true;
			for (const remove of cleanup) remove();
		},
	};
}
