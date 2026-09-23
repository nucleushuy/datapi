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
	first.shell.selectRight("suggestions");
	first.element("theme-toggle").click();
	first.key("left-splitter", "End");
	const saved = first.browser.localStorage.getItem(SHELL_STORAGE_KEY);
	assert.ok(saved);
	const second = setup(t, saved);
	assert.equal(second.element("center-panel-statistics").hidden, false);
	assert.equal(second.element("right-panel-suggestions").hidden, false);
	assert.equal(second.document.documentElement.dataset.theme, first.document.documentElement.dataset.theme);
	assert.equal(
		second.element("left-splitter").getAttribute("aria-valuenow"),
		first.element("left-splitter").getAttribute("aria-valuenow"),
	);
});

test("keyboard resize clamps both panels and responsive layout retains desktop preference", (t) => {
	const { element, key, browser } = setup(t);
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
			version: 1,
			leftWidth: -9999,
			rightWidth: 99999,
			theme: "injected",
			centerTab: "bogus",
			rightTab: "bogus",
		}),
	]) {
		const { element, document } = setup(t, saved);
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
