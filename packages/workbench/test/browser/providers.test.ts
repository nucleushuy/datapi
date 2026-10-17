import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Window as TestWindow } from "happy-dom";
import { createProviders } from "../../src/browser/providers.ts";
import type {
	ProviderAuthOperation,
	ProviderCatalog,
	ProviderModel,
	ProviderSummary,
	SessionModelSelection,
	SessionModelState,
} from "../../src/provider-contracts.ts";

function provider(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
	return {
		id: "future-provider",
		name: "Future Provider",
		auth: {
			oauth: { label: "Sign in securely with Future", subscription: true },
			apiKey: { label: "Enter Future access key", interactive: true },
		},
		state: "connected",
		configured: true,
		authType: "oauth",
		storedAuthType: "oauth",
		source: "stored",
		modelCount: 1,
		message: "Configured through Pi; identity is not verified.",
		...overrides,
	};
}
function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
	return {
		provider: "future-provider",
		id: "future/reasoner",
		name: "Future Reasoner",
		contextWindow: 96000,
		maxTokens: 4096,
		input: ["text", "image"],
		reasoning: true,
		thinkingLevels: ["off", "low", "high"],
		cost: { input: 0.25, output: 0.75, cacheRead: 0.1, cacheWrite: 0.3 },
		billing: "subscription",
		virtual: false,
		...overrides,
	};
}
function operation(overrides: Partial<ProviderAuthOperation> = {}): ProviderAuthOperation {
	return {
		id: "flow-1",
		providerId: "future-provider",
		authType: "oauth",
		state: "waiting_browser",
		done: false,
		message: "Waiting for authentication…",
		prompts: [],
		events: [],
		...overrides,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function settle() {
	for (let index = 0; index < 5; index++) await setImmediate();
}
function setup(
	t: TestContext,
	config: {
		providers?: ProviderSummary[];
		models?: ProviderModel[];
		state?: SessionModelState;
		respond?(path: string, init: RequestInit): unknown | Promise<unknown>;
		select?(value: SessionModelSelection): Promise<SessionModelState>;
	} = {},
) {
	const browser = new TestWindow({ url: "http://localhost:4310", width: 360, height: 800 });
	const document = browser.document as unknown as Document;
	const opener = document.createElement("button");
	opener.textContent = "Open providers";
	const root = document.createElement("div");
	document.body.append(opener, root);
	const requests: { path: string; method: string; body?: string; signal?: AbortSignal | null }[] = [];
	const selections: SessionModelSelection[] = [];
	const opened: { url: string; target?: string; features?: string }[] = [];
	const copied: string[] = [];
	let changes = 0;
	const timers = new Map<number, () => void>();
	let timerId = 0;
	// Drive only our operation-status timer; no wall-clock sleeps or provider polling.
	Object.defineProperty(browser, "setTimeout", {
		configurable: true,
		value: (callback: () => void) => {
			const id = ++timerId;
			timers.set(id, callback);
			return id;
		},
	});
	Object.defineProperty(browser, "clearTimeout", {
		configurable: true,
		value: (id: number) => {
			timers.delete(id);
		},
	});
	Object.defineProperty(browser, "open", {
		configurable: true,
		value: (url: string, target?: string, features?: string) => {
			opened.push({ url, target, features });
			return null;
		},
	});
	Object.defineProperty(browser.navigator, "clipboard", {
		configurable: true,
		value: {
			async writeText(value: string) {
				copied.push(value);
			},
		},
	});
	const catalog: ProviderCatalog = {
		providers: config.providers ?? [provider()],
		models: config.models ?? [model()],
		guidance: "Only configured models from Pi are listed.",
	};
	const state: SessionModelState = config.state ?? { model: model(), thinkingLevel: "low", routedModel: null };
	const controller = createProviders({
		root,
		async request<T>(path: string, init: RequestInit = {}): Promise<T> {
			requests.push({
				path,
				method: init.method ?? "GET",
				body: typeof init.body === "string" ? init.body : undefined,
				signal: init.signal,
			});
			const response = config.respond?.(path, init);
			if (response !== undefined) return (await response) as T;
			if (
				path === "/api/providers" ||
				path.endsWith("/continue") ||
				(path.startsWith("/api/providers/") && init.method === "DELETE")
			)
				return structuredClone(catalog) as T;
			if (path === "/api/chat/models")
				return { models: structuredClone(catalog.models), guidance: catalog.guidance } as T;
			if (path.endsWith("/auth")) return operation() as T;
			if (path.startsWith("/api/provider-auth/"))
				return operation(
					init.method === "DELETE" ? { state: "cancelled", done: true, message: "Authentication cancelled." } : {},
				) as T;
			throw new Error("Unexpected test request");
		},
		async getModelState() {
			return structuredClone(state);
		},
		async onModelsChanged() {
			changes++;
		},
		async onSelectModel(value) {
			selections.push(value);
			return config.select
				? config.select(value)
				: {
						model:
							catalog.models.find((item) => item.provider === value.provider && item.id === value.modelId) ??
							null,
						thinkingLevel: value.thinkingLevel,
						routedModel: null,
					};
		},
	});
	t.after(async () => {
		controller.dispose();
		await browser.happyDOM.close();
	});
	function button(text: string) {
		const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
		assert.ok(found, `Button ${text}`);
		return found;
	}
	function input(selector: string) {
		const found = root.querySelector<HTMLInputElement>(selector);
		assert.ok(found, selector);
		return found;
	}
	function submit(selector: string) {
		const form = root.querySelector(selector);
		assert.ok(form, selector);
		form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
	}
	function event(target: Element, type: string) {
		target.dispatchEvent(new browser.Event(type, { bubbles: true }) as unknown as Event);
	}
	async function poll() {
		const callbacks = [...timers.values()];
		timers.clear();
		for (const callback of callbacks) callback();
		await settle();
	}
	return {
		browser,
		document,
		root,
		opener,
		controller,
		requests,
		selections,
		opened,
		copied,
		catalog,
		button,
		input,
		submit,
		event,
		poll,
		changes: () => changes,
	};
}

test("provider discovery, counts and authentication choices come only from runtime DTOs", async (t) => {
	const ui = setup(t, {
		providers: [
			provider({ configured: false, state: "disconnected", authType: null, storedAuthType: null, modelCount: 17 }),
			provider({
				id: "ambient",
				name: "Ambient Cloud",
				auth: { oauth: null, apiKey: { label: "Environment", interactive: false } },
				configured: false,
				storedAuthType: null,
			}),
		],
	});
	ui.controller.open();
	await settle();
	assert.equal(ui.root.querySelectorAll(".provider-row").length, 2);
	assert.match(ui.root.textContent!, /17 available models/);
	const search = ui.input("input[aria-label='Search providers']");
	search.value = "future";
	ui.event(search, "input");
	assert.equal(ui.root.querySelectorAll(".provider-row").length, 1);
	ui.button("Connect").click();
	assert.ok(ui.button("Sign in securely with Future"));
	assert.ok(ui.button("Enter Future access key"));
	assert.equal(ui.root.querySelectorAll("input[type='password']").length, 0);
	ui.controller.open("ambient");
	await settle();
	assert.match(ui.root.textContent!, /ambient configuration rather than an interactive sign-in/);
	assert.equal(ui.root.querySelectorAll("input[type='password']").length, 0);
});

test("continuing connected OAuth reuses credentials and advances directly to models", async (t) => {
	const ui = setup(t);
	ui.controller.open("future-provider");
	await settle();
	assert.match(ui.root.textContent!, /A Future Provider connection is already available for this profile/);
	assert.match(ui.root.textContent!, /does not verify account identity, key validity/);
	ui.button("Continue with connected account").click();
	await settle();
	assert.ok(
		ui.requests.some((item) => item.path === "/api/providers/future-provider/continue" && item.method === "POST"),
	);
	assert.ok(!ui.requests.some((item) => item.path.endsWith("/auth")));
	assert.equal(ui.root.querySelector("[aria-current='step']")?.textContent, "Model");
	assert.equal(ui.changes(), 1);
	assert.ok(ui.root.querySelector("input[type='radio']"));
});

test("continue respects Pi reconnection and missing configuration outcomes", async (t) => {
	for (const outcome of [
		provider({ configured: true, state: "reconnect_required" }),
		provider({ configured: false, state: "reconnect_required" }),
		provider({ configured: false, state: "disconnected" }),
	]) {
		await t.test(`${outcome.state}, configured=${outcome.configured}`, async (t) => {
			outcome.message = "Pi could not resolve this connection. Refresh or reconnect it.";
			const ui = setup(t, {
				respond(path) {
					if (path.endsWith("/continue"))
						return { providers: [outcome], models: [model()], guidance: "Reconnect this provider." };
				},
			});
			ui.controller.open("future-provider");
			await settle();
			ui.button("Continue with connected account").click();
			await settle();
			assert.match(
				ui.root.textContent!,
				outcome.state === "reconnect_required" ? /Reconnection required/ : /Not connected/,
			);
			assert.match(ui.root.textContent!, /Pi could not resolve this connection/);
			assert.doesNotMatch(ui.root.textContent!, /connection is already available|Continue with connected account/);
			assert.equal(ui.root.querySelector("[aria-current='step']")?.textContent, "Account");
			assert.equal(ui.root.querySelector(".provider-model-form"), null);
			assert.ok(!ui.requests.some((item) => item.path === "/api/chat/models" || item.path.endsWith("/auth")));
			assert.equal(ui.changes(), 1);
			ui.button("Sign in securely with Future").click();
			await settle();
			assert.deepEqual(JSON.parse(ui.requests.find((item) => item.path.endsWith("/auth"))!.body!), {
				type: "oauth",
			});
		});
	}
});

test("continuing authenticated cached models does not require a new login", async (t) => {
	const ui = setup(t, {
		respond(path) {
			if (path.endsWith("/continue"))
				return {
					providers: [provider({ state: "offline_cached" })],
					models: [model()],
					guidance: "Catalog refresh unavailable; using cached models.",
				};
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Continue with connected account").click();
	await settle();
	assert.equal(ui.root.querySelector("[aria-current='step']")?.textContent, "Model");
	assert.ok(ui.root.querySelector("input[type='radio']"));
	assert.ok(!ui.requests.some((item) => item.path.endsWith("/auth")));
	assert.equal(ui.changes(), 1);
});

test("account replacement starts OAuth without logout and cancellation removes transient prompts", async (t) => {
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/auth"))
				return operation({ prompts: [{ id: "manual", type: "manual_code", message: "Paste callback URL" }] });
			if (path === "/api/provider-auth/flow-1" && init.method === "GET")
				return operation({ prompts: [{ id: "manual", type: "manual_code", message: "Paste callback URL" }] });
		},
	});
	ui.opener.focus();
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	assert.deepEqual(JSON.parse(ui.requests.find((item) => item.path.endsWith("/auth"))!.body!), { type: "oauth" });
	assert.ok(!ui.requests.some((item) => item.method === "DELETE"));
	const input = ui.input("input[type='password']");
	input.value = "private-callback-code";
	await ui.poll();
	const poll = ui.requests.find((item) => item.path === "/api/provider-auth/flow-1" && item.method === "GET")!;
	ui.button("Cancel authentication").click();
	await settle();
	assert.equal(poll.signal?.aborted, true);
	assert.equal(input.value, "");
	assert.equal(ui.root.querySelectorAll(".provider-auth-prompt").length, 0);
	assert.ok(ui.requests.some((item) => item.path === "/api/provider-auth/flow-1" && item.method === "DELETE"));
	assert.ok(!ui.requests.some((item) => item.path === "/api/providers/future-provider" && item.method === "DELETE"));
	assert.match(ui.root.textContent!, /Authentication cancelled/);
	ui.button("Close").click();
	await settle();
	assert.equal(ui.document.activeElement, ui.opener);
});

test("saved keys use exact key wording, clear immediately on submission and never echo raw errors", async (t) => {
	const result = deferred<ProviderAuthOperation>();
	const ui = setup(t, {
		providers: [
			provider({
				authType: "api_key",
				storedAuthType: "api_key",
				auth: { oauth: null, apiKey: { label: "Enter Future access key", interactive: true } },
			}),
		],
		respond(path, init) {
			if (path.endsWith("/auth"))
				return operation({
					authType: "api_key",
					prompts: [{ id: "key", type: "secret", message: "API key", placeholder: "Paste key" }],
				});
			if (path === "/api/provider-auth/flow-1" && init.method === "POST") return result.promise;
		},
	});
	ui.controller.open("future-provider");
	await settle();
	assert.ok(ui.button("Continue with saved API key"));
	assert.doesNotMatch(ui.root.textContent!, /another account/);
	ui.button("Replace API key").click();
	await settle();
	const input = ui.input("input[type='password']");
	assert.equal(input.autocomplete, "off");
	assert.equal(input.getAttribute("data-1p-ignore"), "true");
	assert.equal(input.name, "");
	input.value = "secret-never-persist";
	ui.submit(".provider-auth-prompt");
	assert.equal(input.value, "");
	assert.equal(input.disabled, true);
	assert.deepEqual(
		JSON.parse(
			ui.requests.find((item) => item.path === "/api/provider-auth/flow-1" && item.method === "POST")!.body!,
		),
		{ promptId: "key", value: "secret-never-persist" },
	);
	result.reject(new Error("provider returned secret-never-persist"));
	await settle();
	assert.equal(input.value, "");
	assert.equal(input.disabled, false);
	assert.doesNotMatch(ui.root.innerHTML, /secret-never-persist/);
	assert.equal(ui.browser.localStorage.length, 0);
	assert.equal(ui.browser.sessionStorage.length, 0);
	assert.equal(ui.document.cookie, "");
	assert.match(ui.root.textContent!, /response could not be submitted/);
});

test("all prompt types preserve exact answers and Pi can remove one prompt without cancelling login", async (t) => {
	let status = operation({
		prompts: [
			{ id: "text", type: "text", message: "Organization" },
			{
				id: "choice",
				type: "select",
				message: "Sign-in method",
				options: [
					{ id: "browser-value", label: "Browser", description: "Local callback" },
					{ id: "device-value", label: "Device code" },
				],
			},
			{ id: "manual", type: "manual_code", message: "Manual code" },
		],
	});
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/auth") || (path === "/api/provider-auth/flow-1" && !init.method))
				return structuredClone(status);
			if (path === "/api/provider-auth/flow-1" && init.method === "POST") {
				const answer = JSON.parse(String(init.body)) as { promptId: string };
				status = { ...status, prompts: status.prompts.filter((item) => item.id !== answer.promptId) };
				return structuredClone(status);
			}
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	const text = ui.input("#provider-prompt-text");
	assert.equal(text.type, "text");
	text.value = "Org exact value";
	ui.submit("[data-prompt-id='text']");
	await settle();
	const select = ui.root.querySelector<HTMLSelectElement>("#provider-prompt-choice")!;
	select.value = "device-value";
	ui.submit("[data-prompt-id='choice']");
	await settle();
	const manual = ui.input("#provider-prompt-manual");
	manual.value = "sensitive-manual-code";
	status = { ...status, prompts: [], state: "verifying" };
	await ui.poll();
	assert.equal(manual.value, "");
	assert.equal(ui.root.querySelectorAll(".provider-auth-prompt").length, 0);
	assert.ok(!ui.requests.some((item) => item.method === "DELETE"));
	assert.deepEqual(
		ui.requests
			.filter((item) => item.path === "/api/provider-auth/flow-1" && item.method === "POST")
			.map((item) => JSON.parse(item.body!).value),
		["Org exact value", "device-value"],
	);
	assert.match(ui.root.textContent!, /Verifying/);
});

test("auth events open and copy exact safe URLs, handle popup blocking and reject malicious links", async (t) => {
	const exact = "https://identity.example/login?state=x%2Fy&redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback";
	const ui = setup(t, {
		respond(path) {
			if (path.endsWith("/auth"))
				return operation({
					events: [
						{
							type: "info",
							message: "<img src=x onerror=alert(1)>",
							links: [
								{ url: "javascript:alert(1)", label: "Unsafe" },
								{ url: "https://name:password@example.test", label: "Credential URL" },
								{ url: "https://help.example/guide", label: "Provider help" },
							],
						},
						{ type: "auth_url", url: exact, instructions: "Complete sign-in in your browser." },
						{ type: "auth_url", url: "data:text/html,unsafe" },
						{ type: "progress", message: "Waiting for provider callback" },
						{ type: "device_code", userCode: "TEST-CODE", verificationUri: "javascript:alert(2)" },
					],
				});
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	assert.deepEqual(ui.opened, [{ url: exact, target: "_blank", features: "noopener,noreferrer" }]);
	assert.match(ui.root.textContent!, /may have blocked the popup/);
	assert.equal(ui.root.querySelectorAll("img, script").length, 0);
	const links = [...ui.root.querySelectorAll<HTMLAnchorElement>("a")];
	assert.deepEqual(
		links.map((item) => item.getAttribute("href")),
		["https://help.example/guide", exact],
	);
	for (const item of links) assert.equal(item.rel, "noopener noreferrer");
	ui.button("Copy authentication link").click();
	await settle();
	assert.deepEqual(ui.copied, [exact]);
	ui.button("Open browser again").click();
	assert.equal(ui.opened[1]?.url, exact);
	assert.match(ui.root.textContent!, /Waiting for provider callback/);
	assert.equal(ui.root.querySelectorAll(".provider-device-expiry").length, 0);
});

test("device expiry exists only when supplied and only application operation status is polled", async (t) => {
	let status = operation({
		state: "waiting_device",
		events: [
			{
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://device.example/verify",
				expiresAt: new Date(Date.now() + 90000).toISOString(),
			},
		],
	});
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/auth") || (path === "/api/provider-auth/flow-1" && !init.method))
				return structuredClone(status);
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	assert.match(ui.root.querySelector(".provider-device-expiry")!.textContent!, /Code expires in 1:/);
	ui.button("Copy device code").click();
	await settle();
	assert.deepEqual(ui.copied, ["ABCD-1234"]);
	status = {
		...status,
		events: [{ type: "device_code", userCode: "NEXT-CODE", verificationUri: "https://device.example/verify" }],
	};
	await ui.poll();
	assert.equal(ui.root.querySelectorAll(".provider-device-expiry").length, 0);
	assert.ok(ui.requests.every((item) => item.path.startsWith("/api/")));
	assert.ok(ui.requests.some((item) => item.path === "/api/provider-auth/flow-1" && item.method === "GET"));
});

test("disconnect confirms scope and renders surviving environment authentication from server", async (t) => {
	const ui = setup(t, {
		respond(path, init) {
			if (path === "/api/providers/future-provider" && init.method === "DELETE")
				return {
					providers: [
						provider({
							state: "environment",
							source: "environment",
							storedAuthType: null,
							authType: "api_key",
							message: "",
						}),
					],
					models: [model()],
					guidance: "",
				};
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Disconnect").click();
	assert.match(
		ui.root.textContent!,
		/may not revoke provider access or remove credentials configured through environment variables/,
	);
	assert.ok(!ui.requests.some((item) => item.method === "DELETE"));
	ui.button("Disconnect").click();
	await settle();
	assert.match(ui.root.textContent!, /Available through environment configuration/);
	assert.equal(ui.changes(), 1);
});

test("model metadata, search, default opt-in and completion use authoritative session response", async (t) => {
	const selection = deferred<SessionModelState>();
	const auto = model({
		provider: "router",
		id: "auto",
		name: "Auto",
		billing: "virtual",
		virtual: true,
		thinkingLevels: ["low", "high"],
	});
	const ui = setup(t, { models: [model(), auto], select: () => selection.promise });
	ui.controller.openModelPicker();
	await settle();
	assert.match(ui.root.textContent!, /96,000 tokens/);
	assert.match(ui.root.textContent!, /4,096 tokens/);
	assert.match(ui.root.textContent!, /text \+ image/);
	assert.match(ui.root.textContent!, /\$0.25 input · \$0.75 output/);
	const persist = ui.input("input[type='checkbox']");
	assert.equal(persist.checked, false);
	const search = ui.input("input[aria-label='Search models']");
	search.value = "missing";
	ui.event(search, "input");
	assert.equal(ui.root.querySelectorAll(".provider-model-row:not([hidden])").length, 0);
	search.value = "auto";
	ui.event(search, "input");
	const radio = ui.input("input[aria-label='Auto — Pi chooses — router']");
	radio.click();
	assert.match(
		ui.root.querySelector(".provider-model-disclosure")!.textContent!,
		/existing approved history.*Future Provider/,
	);
	assert.match(ui.root.querySelector(".provider-model-disclosure")!.textContent!, /Selection does not send a message/);
	const thinking = ui.root.querySelector<HTMLSelectElement>("select[aria-label='Thinking level']")!;
	assert.deepEqual(
		[...thinking.options].map((item) => item.value),
		["low", "high"],
	);
	thinking.value = "high";
	persist.checked = true;
	ui.submit(".provider-model-form");
	assert.deepEqual(ui.selections, [{ provider: "router", modelId: "auto", thinkingLevel: "high", persist: true }]);
	assert.ok(ui.button("Applying to session…").disabled);
	assert.doesNotMatch(ui.root.textContent!, /Ready to continue/);
	selection.resolve({ model: auto, thinkingLevel: "low", routedModel: null });
	await settle();
	assert.match(ui.root.textContent!, /Selected Auto — Pi chooses · router · low thinking/);
	assert.equal(ui.requests.filter((item) => item.method !== "GET").length, 0);
});

test("selection failures do not invent state, leak errors, or persist defaults implicitly", async (t) => {
	const ui = setup(t, {
		async select() {
			throw new Error("credential=private-error-body");
		},
	});
	ui.controller.openModelPicker();
	await settle();
	ui.submit(".provider-model-form");
	await settle();
	assert.equal(ui.selections[0]?.persist, false);
	assert.match(ui.root.textContent!, /Current session: Future Reasoner · low thinking/);
	assert.match(ui.root.textContent!, /session model could not be changed/);
	assert.doesNotMatch(ui.root.textContent!, /private-error-body/);
	assert.equal(ui.browser.localStorage.length, 0);
	assert.equal(ui.browser.sessionStorage.length, 0);
});

test("keyboard focus stays in the dialog and Escape cancels before restoring opener", async (t) => {
	const ui = setup(t);
	ui.opener.focus();
	ui.controller.open("future-provider");
	await settle();
	const close = ui.button("Close");
	close.focus();
	close.dispatchEvent(
		new ui.browser.KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}) as unknown as Event,
	);
	assert.equal(ui.document.activeElement, ui.button("Back to providers"));
	ui.button("Back to providers").dispatchEvent(
		new ui.browser.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }) as unknown as Event,
	);
	assert.equal(ui.document.activeElement, close);
	ui.button("Use another account").click();
	await settle();
	ui.root.querySelector("dialog")!.dispatchEvent(
		new ui.browser.KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		}) as unknown as Event,
	);
	await settle();
	assert.ok(ui.requests.some((item) => item.path === "/api/provider-auth/flow-1" && item.method === "DELETE"));
	assert.equal(ui.root.querySelector<HTMLDialogElement>("dialog")!.open, false);
	assert.equal(ui.document.activeElement, ui.opener);
});

test("late operation starts are cancelled after disposal rather than reopening UI", async (t) => {
	const started = deferred<ProviderAuthOperation>();
	const ui = setup(t, {
		respond(path) {
			if (path.endsWith("/auth")) return started.promise;
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	ui.controller.dispose();
	started.resolve(operation());
	await settle();
	assert.ok(ui.requests.some((item) => item.path === "/api/provider-auth/flow-1" && item.method === "DELETE"));
	assert.equal(ui.root.childElementCount, 0);
});

test("successful authentication refreshes models and completes all five steps without fabricated identity", async (t) => {
	let status = operation();
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/auth") || (path === "/api/provider-auth/flow-1" && !init.method))
				return structuredClone(status);
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	status = operation({ done: true, state: "connected", message: "Connection saved through Pi." });
	await ui.poll();
	assert.equal(ui.root.querySelector("[aria-current='step']")?.textContent, "Model");
	assert.equal(ui.changes(), 1);
	assert.ok(ui.requests.some((item) => item.path === "/api/chat/models"));
	ui.submit(".provider-model-form");
	await settle();
	assert.equal(ui.root.querySelector("[aria-current='step']")?.textContent, "Complete");
	assert.match(ui.root.textContent!, /Selected Future Reasoner/);
	assert.doesNotMatch(ui.root.textContent!, /@|verified identity/);
});

test("failed authentication and reconnection remain actionable without claiming a connection", async (t) => {
	const ui = setup(t, {
		providers: [provider({ configured: false, state: "reconnect_required", message: "Reconnect this provider." })],
		respond(path) {
			if (path.endsWith("/auth"))
				return operation({
					done: true,
					state: "failed",
					message: "Authentication failed. Try again.",
					prompts: [],
				});
		},
	});
	ui.controller.open();
	await settle();
	assert.match(ui.root.textContent!, /Reconnection required/);
	ui.button("Connect").click();
	ui.button("Sign in securely with Future").click();
	await settle();
	assert.match(ui.root.textContent!, /Connection failed/);
	assert.equal(ui.root.querySelectorAll("input[type='radio']").length, 0);
	ui.button("Back to connection").click();
	await settle();
	assert.ok(ui.button("Sign in securely with Future"));
});

test("failed cancellation keeps the modal open and permits retry before closing", async (t) => {
	let attempts = 0;
	const ui = setup(t, {
		respond(path, init) {
			if (path === "/api/provider-auth/flow-1" && init.method === "DELETE" && attempts++ === 0)
				return Promise.reject(new Error("raw token response"));
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	ui.button("Close").click();
	await settle();
	assert.equal(ui.root.querySelector<HTMLDialogElement>("dialog")!.open, true);
	assert.match(ui.root.textContent!, /Cancellation could not be confirmed/);
	assert.doesNotMatch(ui.root.textContent!, /raw token response/);
	ui.button("Retry cancellation").click();
	await settle();
	assert.match(ui.root.textContent!, /Authentication cancelled/);
	ui.button("Close").click();
	assert.equal(ui.root.querySelector<HTMLDialogElement>("dialog")!.open, false);
});

test("closing during auth startup cancels the returned operation before dismissing", async (t) => {
	const started = deferred<ProviderAuthOperation>();
	const ui = setup(t, {
		respond(path) {
			if (path.endsWith("/auth")) return started.promise;
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	ui.button("Close").click();
	assert.equal(ui.root.querySelector<HTMLDialogElement>("dialog")!.open, true);
	started.resolve(operation());
	await settle();
	assert.ok(ui.requests.some((item) => item.path === "/api/provider-auth/flow-1" && item.method === "DELETE"));
	assert.equal(ui.root.querySelector<HTMLDialogElement>("dialog")!.open, false);
});

test("closing idle picker then reopening cannot dismiss the new provider screen", async (t) => {
	const ui = setup(t);
	ui.controller.openModelPicker();
	await settle();
	ui.controller.close();
	ui.controller.open();
	await settle();
	assert.equal(ui.root.querySelector<HTMLDialogElement>("dialog")!.open, true);
	assert.ok(ui.root.querySelector("input[aria-label='Search providers']"));
});

test("stale status responses cannot resurrect a provider-aborted prompt after answering", async (t) => {
	const stale = deferred<ProviderAuthOperation>();
	const initial = operation({ prompts: [{ id: "code", type: "manual_code", message: "Paste code" }] });
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/auth")) return initial;
			if (path === "/api/provider-auth/flow-1" && !init.method) return stale.promise;
			if (path === "/api/provider-auth/flow-1" && init.method === "POST") return operation({ state: "verifying" });
		},
	});
	ui.controller.open("future-provider");
	await settle();
	ui.button("Use another account").click();
	await settle();
	await ui.poll();
	ui.input("#provider-prompt-code").value = "one-use-code";
	ui.submit(".provider-auth-prompt");
	await settle();
	stale.resolve(initial);
	await settle();
	assert.equal(ui.root.querySelectorAll(".provider-auth-prompt").length, 0);
	assert.match(ui.root.textContent!, /Verifying/);
});

test("model filtering cannot silently apply a hidden selected model", async (t) => {
	const ui = setup(t);
	ui.controller.openModelPicker();
	await settle();
	const search = ui.input("input[aria-label='Search models']");
	search.value = "not available";
	ui.event(search, "input");
	assert.equal(ui.button("Use model").disabled, true);
	ui.submit(".provider-model-form");
	assert.equal(ui.selections.length, 0);
});

test("empty available catalog guides users to providers without synthesizing model rows", async (t) => {
	const ui = setup(t, { models: [], state: { model: null, thinkingLevel: "off", routedModel: null } });
	ui.controller.openModelPicker();
	await settle();
	assert.equal(ui.root.querySelectorAll("input[type='radio']").length, 0);
	assert.match(ui.root.textContent!, /connect a provider/);
	assert.equal(ui.button("Use model").disabled, true);
	ui.button("Manage providers").click();
	await settle();
	assert.ok(ui.root.querySelector(".provider-row"));
});

test("provider load failure stays generic and retry can recover", async (t) => {
	let fail = true;
	const ui = setup(t, {
		respond(path) {
			if (path === "/api/providers" && fail) return Promise.reject(new Error("sensitive-provider-body"));
		},
	});
	ui.controller.open();
	await settle();
	assert.match(ui.root.textContent!, /Providers could not be loaded/);
	assert.doesNotMatch(ui.root.textContent!, /sensitive-provider-body/);
	fail = false;
	ui.button("Try again").click();
	await settle();
	assert.ok(ui.root.querySelector(".provider-row"));
});
