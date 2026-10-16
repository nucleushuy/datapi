import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { Window as TestWindow } from "happy-dom";
import { initializeShell, SHELL_STORAGE_KEY, type ShellOptions } from "../../src/browser/shell.ts";

const html = await readFile(new URL("../../src/browser/index.html", import.meta.url), "utf8");

function setup(t: TestContext, saved?: string, width = 1440, options?: ShellOptions) {
	const browser = new TestWindow({
		url: "http://localhost:4310",
		width,
		height: 900,
		settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
	});
	browser.document.write(html);
	if (saved !== undefined) browser.localStorage.setItem(SHELL_STORAGE_KEY, saved);
	const document = browser.document as unknown as Document;
	const window = browser as unknown as Window;
	const shell = initializeShell(document, window, options);
	t.after(async () => {
		shell.dispose();
		await browser.happyDOM.close();
	});
	function element<T extends HTMLElement = HTMLElement>(id: string): T {
		const value = document.getElementById(id);
		assert.ok(value, id);
		return value as T;
	}
	function key(id: string, key: string) {
		element(id).dispatchEvent(
			new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as KeyboardEvent,
		);
	}
	return { browser, document, window, shell, element, key };
}

test("workspace and inspector tabs use independent roving focus and persist selections", (t) => {
	const { element, document, key, browser } = setup(t);
	assert.equal(document.getElementById("center-tab-chat"), null);
	assert.ok(document.getElementById("chat-workspace"));
	element("rail-data").click();
	element("center-tab-data").focus();
	key("center-tab-data", "ArrowRight");
	assert.equal(document.activeElement?.id, "center-tab-code");
	assert.equal(element("center-tab-code").getAttribute("aria-selected"), "true");
	assert.equal(element("center-tab-data").tabIndex, -1);
	assert.equal(element("center-panel-data").hidden, true);
	assert.equal(element("center-panel-code").hidden, false);
	key("center-tab-code", "End");
	assert.equal(document.activeElement?.id, "center-tab-models");
	key("center-tab-models", "ArrowRight");
	assert.equal(document.activeElement?.id, "center-tab-data");
	key("right-tab-assistant", "End");
	assert.equal(document.activeElement?.id, "right-tab-activity");
	assert.equal(element("right-panel-activity").hidden, false);
	assert.equal(element("center-panel-data").hidden, false);
	const saved = JSON.parse(browser.localStorage.getItem(SHELL_STORAGE_KEY) ?? "null");
	assert.equal(saved.centerTab, "data");
	assert.equal(saved.rightTab, "activity");
});

test("stored themes, tabs and panel widths survive a fresh controller", (t) => {
	const first = setup(t);
	first.shell.selectCenter("statistics");
	first.shell.selectRight("activity");
	first.element("theme-toggle").click();
	first.key("left-splitter", "End");
	const saved = first.browser.localStorage.getItem(SHELL_STORAGE_KEY);
	assert.ok(saved);
	const second = setup(t, saved);
	second.shell.navigate("data", false);
	assert.equal(second.element("center-panel-statistics").hidden, false);
	assert.equal(second.element("right-panel-activity").hidden, false);
	assert.equal(second.document.documentElement.dataset.theme, first.document.documentElement.dataset.theme);
	assert.equal(
		second.element("left-splitter").getAttribute("aria-valuenow"),
		first.element("left-splitter").getAttribute("aria-valuenow"),
	);
});

test("version one layouts retain Data and preserve panel widths and theme", (t) => {
	const { element, document } = setup(
		t,
		JSON.stringify({
			version: 1,
			leftWidth: 320,
			rightWidth: 360,
			centerTab: "data",
			rightTab: "activity",
			theme: "light",
		}),
	);
	element("rail-data").click();
	assert.equal(element("center-panel-data").hidden, false);
	assert.equal(element("left-splitter").getAttribute("aria-valuenow"), "320");
	assert.equal(element("right-splitter").getAttribute("aria-valuenow"), "360");
	assert.equal(element("right-panel-activity").hidden, false);
	assert.equal(document.documentElement.dataset.theme, "light");
});

test("keyboard resize clamps both panels and responsive layout retains desktop preference", (t) => {
	const { element, key, browser } = setup(t);
	element("rail-data").click();
	key("left-splitter", "Home");
	assert.equal(element("left-splitter").getAttribute("aria-valuenow"), "180");
	key("left-splitter", "ArrowLeft");
	assert.equal(element("left-splitter").getAttribute("aria-valuenow"), "180");
	key("left-splitter", "End");
	key("right-splitter", "End");
	const saved = browser.localStorage.getItem(SHELL_STORAGE_KEY);
	const desktopLeft = element("left-splitter").getAttribute("aria-valuenow");
	browser.happyDOM.setViewport({ width: 768 });
	browser.dispatchEvent(new browser.Event("resize"));
	assert.equal(element("right-splitter").hidden, true);
	assert.equal(browser.localStorage.getItem(SHELL_STORAGE_KEY), saved);
	browser.happyDOM.setViewport({ width: 390 });
	browser.dispatchEvent(new browser.Event("resize"));
	assert.equal(element("left-splitter").hidden, true);
	browser.happyDOM.setViewport({ width: 1440 });
	browser.dispatchEvent(new browser.Event("resize"));
	assert.equal(element("left-splitter").getAttribute("aria-valuenow"), desktopLeft);
	assert.equal(element("right-splitter").hidden, false);
});

test("command palette filters, reports no results, executes tabs and restores cancellation focus", (t) => {
	const { element, browser, document, key } = setup(t);
	element("command-trigger").focus();
	element("command-trigger").click();
	assert.equal(element<HTMLDialogElement>("command-dialog").open, true);
	const search = element<HTMLInputElement>("command-search");
	search.value = "no-such-command";
	search.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
	assert.equal(element("command-empty").hidden, false);
	search.value = "statistics";
	search.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
	assert.equal(element("command-empty").hidden, true);
	key("command-search", "Enter");
	assert.equal(element("center-panel-statistics").hidden, false);
	assert.equal(document.body.dataset.destination, "data");
	assert.equal(element<HTMLDialogElement>("command-dialog").open, false);
	element("command-trigger").focus();
	element("command-trigger").click();
	key("command-search", "Tab");
	assert.equal(document.activeElement?.id, "command-close");
	element("command-close").dispatchEvent(
		new browser.KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}) as unknown as KeyboardEvent,
	);
	assert.equal(document.activeElement?.id, "command-search");
	element("command-close").click();
	assert.equal(document.activeElement?.id, "command-trigger");
});

test("corrupt and out-of-range preferences cannot break the shell", (t) => {
	for (const saved of [
		"{broken",
		JSON.stringify({ version: 500, centerTab: "unknown" }),
		JSON.stringify({
			version: 2,
			leftWidth: -9999,
			rightWidth: 99999,
			theme: "injected",
			centerTab: "bogus",
			rightTab: "bogus",
		}),
	]) {
		const { element, document } = setup(t, saved);
		element("rail-data").click();
		assert.equal(element("center-panel-data").hidden, false);
		assert.ok(["dark", "light"].includes(document.documentElement.dataset.theme ?? ""));
		assert.ok(Number(element("left-splitter").getAttribute("aria-valuenow")) >= 180);
		assert.ok(Number(element("right-splitter").getAttribute("aria-valuenow")) <= 500);
	}
});

test("loading, dataset availability and safe runtime recovery stay observable", (t) => {
	const { shell, element, browser } = setup(t);
	shell.setLoading(true);
	assert.equal(element("shell-loading").hidden, false);
	shell.setLoading(false);
	assert.equal(element("shell-loading").hidden, true);
	shell.setDatasetAvailable(false);
	assert.equal(element("shell-statistics-empty").hidden, false);
	shell.setDatasetAvailable(true);
	assert.equal(element("shell-statistics-content").hidden, false);
	assert.equal(element("shell-statistics-empty").hidden, true);
	browser.dispatchEvent(new browser.ErrorEvent("error", { message: "sensitive cell value" }));
	assert.equal(element("shell-error").hidden, false);
	assert.doesNotMatch(element("shell-error").textContent ?? "", /sensitive cell value/);
	shell.selectCenter("code");
	assert.equal(element("center-panel-code").hidden, false);
});

test("unavailable browser storage preserves navigation and displays a warning", (t) => {
	const { shell, browser, element } = setup(t);
	Object.defineProperty(browser, "localStorage", {
		get() {
			throw new Error("Storage blocked");
		},
	});
	shell.selectCenter("models");
	assert.equal(element("center-panel-models").hidden, false);
	assert.equal(element("shell-storage-note").hidden, false);
});

test("dispose removes shell event handlers", (t) => {
	const { shell, element, document, browser } = setup(t);
	const theme = document.documentElement.dataset.theme;
	shell.dispose();
	element("rail-data").click();
	assert.equal(document.body.dataset.destination, "chat");
	element("theme-toggle").click();
	assert.equal(document.documentElement.dataset.theme, theme);
	browser.dispatchEvent(new browser.ErrorEvent("error"));
	assert.equal(element("shell-error").hidden, true);
});

test("command palette shortcuts can be replaced without retaining the default", (t) => {
	const { browser, document, element } = setup(t, undefined, 1440, {
		keybindings: { commandPalette: [{ key: "p", ctrl: true, shift: true }] },
	});
	document.dispatchEvent(
		new browser.KeyboardEvent("keydown", {
			key: "k",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		}) as unknown as KeyboardEvent,
	);
	assert.equal(element<HTMLDialogElement>("command-dialog").open, false);
	document.dispatchEvent(
		new browser.KeyboardEvent("keydown", {
			key: "P",
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}) as unknown as KeyboardEvent,
	);
	assert.equal(element<HTMLDialogElement>("command-dialog").open, true);
});

test("pointer resizing commits on release and rolls back on cancellation", (t) => {
	const { element, browser, window } = setup(t);
	element("rail-data").click();
	function pointer(target: EventTarget, type: string, x: number) {
		target.dispatchEvent(
			new browser.PointerEvent(type, {
				pointerId: 1,
				button: 0,
				clientX: x,
				bubbles: true,
				cancelable: true,
			}) as unknown as PointerEvent,
		);
	}
	const left = element("left-splitter");
	pointer(left, "pointerdown", 240);
	pointer(window, "pointermove", 290);
	assert.equal(left.getAttribute("aria-valuenow"), "290");
	pointer(window, "pointerup", 290);
	const saved = browser.localStorage.getItem(SHELL_STORAGE_KEY);
	assert.equal(JSON.parse(saved ?? "null").leftWidth, 290);
	pointer(left, "pointerdown", 290);
	pointer(window, "pointermove", 350);
	assert.equal(left.getAttribute("aria-valuenow"), "350");
	pointer(window, "pointercancel", 350);
	assert.equal(left.getAttribute("aria-valuenow"), "290");
	assert.equal(browser.localStorage.getItem(SHELL_STORAGE_KEY), saved);
	assert.equal(element("shell-layout").dataset.resizing, undefined);
});

test("chat is the primary destination and every rail destination retains the dataset DOM", (t) => {
	const { document, element } = setup(t);
	const workspace = element("workspace");
	const chat = element("chat-workspace");
	assert.equal(document.body.dataset.destination, "chat");
	assert.equal(element("chat-destination").hidden, false);
	assert.equal(element("data-destination").hidden, true);
	assert.equal(element("session-sidebar").hidden, false);
	assert.equal(element("left-splitter").hidden, true);
	assert.equal(chat.closest("#inspector-panel"), null);
	for (const [id, destination] of [
		["rail-files", "data"],
		["rail-data", "data"],
		["rail-tools", "tools"],
		["rail-settings", "settings"],
	]) {
		element(id).click();
		assert.equal(document.body.dataset.destination, destination);
		assert.equal(element(`${destination}-destination`).hidden, false);
		assert.equal(element("chat-destination").hidden, true);
		assert.equal(element(id).getAttribute("aria-current"), "page");
	}
	element("settings-back-chat").click();
	assert.equal(document.body.dataset.destination, "chat");
	assert.equal(document.activeElement, chat);
	assert.equal(element("workspace"), workspace);
	assert.equal(element("chat-workspace"), chat);
	assert.equal(document.querySelectorAll("#project-select").length, 1);
});

test("shell actions dispatch conversation events and honor requested destinations", (t) => {
	const { document, element } = setup(t);
	const StringCustomEvent = document.defaultView!.CustomEvent as unknown as {
		new (type: string, eventInitDict?: CustomEventInit<string>): CustomEvent<string>;
	};
	const events: string[] = [];
	for (const type of ["workbench:new-session", "workbench:open-settings", "workbench:open-tools"]) {
		document.addEventListener(type, () => events.push(type));
	}
	element("rail-new-session").click();
	element("rail-settings").click();
	element("settings-provider").click();
	assert.equal(document.body.dataset.destination, "settings");
	element("rail-tools").click();
	element("tools-review-chat").click();
	assert.deepEqual(events, ["workbench:new-session", "workbench:open-settings", "workbench:open-settings", "workbench:open-tools"]);
	document.dispatchEvent(new StringCustomEvent("workbench:navigate", { detail: "data" }));
	assert.equal(document.body.dataset.destination, "data");
	document.dispatchEvent(new StringCustomEvent("workbench:navigate", { detail: "unknown" }));
	assert.equal(document.body.dataset.destination, "data");
});

test("command settings opens Providers and modal inputs do not trigger background shortcuts", (t) => {
	const { browser, document, element, key } = setup(t);
	let opened = 0;
	document.addEventListener("workbench:open-settings", () => ++opened);
	element("command-trigger").click();
	const search = element<HTMLInputElement>("command-search");
	search.value = "settings";
	search.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
	key("command-search", "Enter");
	assert.equal(opened, 1);
	assert.equal(document.body.dataset.destination, "settings");
	const modal = document.createElement("dialog");
	modal.setAttribute("aria-modal", "true");
	const prompt = document.createElement("input");
	modal.append(prompt);
	document.body.append(modal);
	modal.showModal();
	prompt.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
	assert.equal(element<HTMLDialogElement>("command-dialog").open, false);
	assert.equal(modal.open, true);
});

test("tools displays the live operation rather than a copied activity view", async (t) => {
	const { browser, element } = setup(t);
	const operation = element("operation");
	const home = operation.parentElement;
	operation.hidden = false;
	element("rail-tools").click();
	assert.equal(operation.parentElement, element("tools-operation-host"));
	await browser.happyDOM.waitUntilComplete();
	assert.equal(element("tools-operation-empty").hidden, true);
	assert.equal(element("shell-operation-link").hidden, false);
	operation.hidden = true;
	await browser.happyDOM.waitUntilComplete();
	assert.equal(element("tools-operation-empty").hidden, false);
	assert.equal(element("shell-operation-link").hidden, true);
	element("rail-data").click();
	assert.equal(operation.parentElement, home);
});

test("sidebar defaults are configurable and desktop collapse persists independently of mobile", (t) => {
	const { browser, document, element } = setup(t, undefined, 1440, {
		keybindings: { toggleSidebar: [{ key: "s", ctrl: true, shift: true }] },
	});
	function shortcut(key: string, shift = false) {
		document.dispatchEvent(
			new browser.KeyboardEvent("keydown", {
				key,
				ctrlKey: true,
				shiftKey: shift,
				bubbles: true,
				cancelable: true,
			}) as unknown as Event,
		);
	}
	shortcut("b");
	assert.equal(element("session-sidebar").hidden, false);
	shortcut("S", true);
	assert.equal(element("session-sidebar").hidden, true);
	assert.equal(element("rail-sessions").getAttribute("aria-expanded"), "false");
	const saved = browser.localStorage.getItem(SHELL_STORAGE_KEY);
	assert.ok(saved);
	assert.equal(JSON.parse(saved).sidebarCollapsed, true);
	const restored = setup(t, saved);
	assert.equal(restored.element("session-sidebar").hidden, true);
	browser.happyDOM.setViewport({ width: 390 });
	browser.dispatchEvent(new browser.Event("resize"));
	element("rail-sessions").click();
	assert.equal(element("session-sidebar").hidden, false);
	assert.equal(browser.localStorage.getItem(SHELL_STORAGE_KEY), saved);
	browser.happyDOM.setViewport({ width: 1440 });
	browser.dispatchEvent(new browser.Event("resize"));
	assert.equal(element("session-sidebar").hidden, true);
	assert.equal(element("chat-workspace").inert, false);
});

test("default sidebar shortcuts work with either platform modifier", (t) => {
	const { browser, document, element } = setup(t);
	for (const modifier of ["ctrlKey", "metaKey"]) {
		document.dispatchEvent(
			new browser.KeyboardEvent("keydown", {
				key: "b",
				[modifier]: true,
				bubbles: true,
				cancelable: true,
			}) as unknown as Event,
		);
		assert.equal(element("session-sidebar").hidden, modifier === "ctrlKey");
	}
});

test("mobile sessions overlay traps keyboard focus and closes with focus restoration", (t) => {
	const { browser, document, element, key } = setup(t, undefined, 390);
	const trigger = element("rail-sessions");
	assert.equal(element("session-sidebar").hidden, true);
	trigger.focus();
	trigger.click();
	assert.equal(element("session-sidebar").getAttribute("aria-modal"), "true");
	assert.equal(element("sidebar-backdrop").hidden, false);
	assert.equal(element("chat-workspace").inert, true);
	assert.equal(document.activeElement?.id, "sidebar-close");
	element("sidebar-close").dispatchEvent(
		new browser.KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}) as unknown as Event,
	);
	assert.equal(document.activeElement?.id, "session-project");
	key("session-project", "Tab");
	assert.equal(document.activeElement?.id, "sidebar-close");
	key("sidebar-close", "Escape");
	assert.equal(element("session-sidebar").hidden, true);
	assert.equal(element("sidebar-backdrop").hidden, true);
	assert.equal(element("chat-workspace").inert, false);
	assert.equal(document.activeElement, trigger);
	trigger.click();
	element("sidebar-backdrop").click();
	assert.equal(document.activeElement, trigger);
});

test("project label mirrors the existing project selector without a second selection state", async (t) => {
	const { browser, document, element } = setup(t);
	const select = element<HTMLSelectElement>("project-select");
	const option = document.createElement("option");
	option.value = "project-local";
	option.textContent = "Local analysis";
	select.replaceChildren(option);
	await browser.happyDOM.waitUntilComplete();
	assert.equal(element("session-project-label").textContent, "Local analysis");
	option.textContent = "Renamed project";
	select.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
	assert.equal(element("session-project-label").textContent, "Renamed project");
	element("session-project").click();
	assert.equal(document.body.dataset.destination, "data");
});
