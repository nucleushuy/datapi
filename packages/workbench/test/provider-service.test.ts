import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	type CredentialStore,
	fauxProvider,
	InMemoryCredentialStore,
	type LoginOptions,
	type OAuthCredential,
	type Provider,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthOperation } from "../src/provider-contracts.ts";
import { ProviderService } from "../src/provider-service.ts";

const providerId = "future-provider-not-in-application";
const oldCredential: OAuthCredential = {
	type: "oauth",
	access: "old-access-secret",
	refresh: "old-refresh-secret",
	expires: Date.now() + 3_600_000,
};
const nextCredential: OAuthCredential = {
	type: "oauth",
	access: "next-access-secret",
	refresh: "next-refresh-secret",
	expires: Date.now() + 3_600_000,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function providerFixture() {
	const faux = fauxProvider({
		provider: providerId,
		models: [
			{
				id: "future-model",
				name: "Future model",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 96_000,
				maxTokens: 12_000,
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			},
		],
	});
	faux.models[0].headers = { Authorization: "header-secret-never-project" };
	faux.models[0].baseUrl = "https://endpoint-secret.invalid/private";
	const state = {
		loginCount: 0,
		refreshCount: 0,
		networkRefreshes: 0,
		failRefresh: false,
		failCatalog: false,
		failSync: false,
		ambient: false,
		login: async (_interaction: ProviderAuthInteraction, _options?: LoginOptions): Promise<OAuthCredential> =>
			nextCredential,
	};
	const provider: Provider = {
		...faux.provider,
		name: "Discovered Future Provider",
		auth: {
			oauth: {
				name: "Future subscription",
				loginLabel: "Sign in with Future",
				isSubscription: true,
				login: async (interaction, options) => {
					state.loginCount++;
					return state.login(interaction, options);
				},
				refresh: async () => {
					state.refreshCount++;
					if (state.failRefresh) throw new Error("private refresh response next-refresh-secret");
					return nextCredential;
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
			apiKey: {
				name: "Future API key",
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({
						type: "secret",
						message: "Paste your API key",
						placeholder: "Your key",
					}),
				}),
				check: async ({ credential }) =>
					credential?.key || state.ambient
						? { type: "api_key", source: state.ambient && !credential?.key ? "FUTURE_KEY" : "API key" }
						: undefined,
				resolve: async ({ credential }) =>
					credential?.key || state.ambient
						? {
								auth: { apiKey: credential?.key ?? "environment-secret" },
								source: state.ambient && !credential?.key ? "FUTURE_KEY" : "API key",
							}
						: undefined,
			},
		},
		refreshModels: async ({ allowNetwork }) => {
			if (state.failSync) throw new Error("sync response with next-refresh-secret");
			if (allowNetwork) {
				state.networkRefreshes++;
				if (state.failCatalog) throw new Error("catalog response with next-access-secret");
			}
		},
	};
	return { provider, state, faux };
}
async function setup(
	t: TestContext,
	options: { store?: CredentialStore; authTimeoutMs?: number; persistent?: boolean } = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "datapi-providers-"));
	const store = options.store ?? new InMemoryCredentialStore();
	const runtime = options.persistent
		? undefined
		: await ModelRuntime.create({
				credentials: store,
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
	const service = await ProviderService.create(dir, {
		runtime,
		authTimeoutMs: options.authTimeoutMs,
		refreshTimeoutMs: 2000,
	});
	const fixture = providerFixture();
	service.runtime.registerNativeProvider(fixture.provider);
	await service.runtime.refresh({ allowNetwork: false, providers: [providerId] });
	t.after(async () => {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, store, service, runtime: service.runtime, ...fixture };
}
async function waitOperation(
	service: ProviderService,
	id: string,
	predicate: (value: ProviderAuthOperation) => boolean,
): Promise<ProviderAuthOperation> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const operation = service.authOperation(id);
		if (predicate(operation)) return operation;
		await delay(5);
	}
	assert.fail("Pi auth operation did not reach the expected state");
}
async function answerKey(service: ProviderService, value: string) {
	const started = service.startAuth(providerId, "api_key");
	const waiting = await waitOperation(service, started.id, (operation) => operation.prompts.length > 0);
	service.answerAuth(started.id, waiting.prompts[0]!.id, value);
	return waitOperation(service, started.id, (operation) => operation.done);
}

describe("Pi-native provider service", { concurrency: false, timeout: 60_000 }, () => {
	it("discovers unknown providers dynamically and only projects Pi-available safe metadata", async (t) => {
		const { service, runtime, store, state } = await setup(t);
		let catalog = await service.catalog();
		const summary = catalog.providers.find((provider) => provider.id === providerId)!;
		assert.equal(summary.name, "Discovered Future Provider");
		assert.deepEqual(summary.auth, {
			oauth: { label: "Sign in with Future", subscription: true },
			apiKey: { label: "Future API key", interactive: true },
		});
		assert.equal(summary.state, "disconnected");
		assert.equal(
			catalog.models.some((model) => model.provider === providerId),
			false,
		);
		await store.modify(providerId, async () => oldCredential);
		catalog = await service.catalog();
		const model = catalog.models.find((entry) => entry.provider === providerId)!;
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, 96_000);
		assert.equal(model.maxTokens, 12_000);
		assert.equal(model.billing, "subscription");
		assert.ok(model.thinkingLevels.includes("high"));
		assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
		assert.deepEqual(
			(await service.models()).map(({ provider, id }) => [provider, id]),
			(await runtime.getAvailable()).map(({ provider, id }) => [provider, id]),
		);
		const json = JSON.stringify(catalog);
		for (const secret of [oldCredential.access, oldCredential.refresh, "header-secret", "endpoint-secret"])
			assert.equal(json.includes(secret), false);
		assert.equal(state.loginCount, 0);
		assert.equal(state.networkRefreshes, 0);
	});

	it("exposes ambient-only capabilities without offering unsupported API-key prompts", async (t) => {
		const { service, runtime, provider, state } = await setup(t);
		state.ambient = true;
		runtime.registerNativeProvider({
			...provider,
			auth: {
				apiKey: {
					name: "Ambient cloud configuration",
					resolve: async () => ({ auth: {}, source: "Cloud profile" }),
				},
			},
		});
		const row = (await service.catalog()).providers.find((entry) => entry.id === providerId)!;
		assert.equal(row.auth.oauth, null);
		assert.deepEqual(row.auth.apiKey, { label: "Ambient cloud configuration", interactive: false });
		assert.equal(row.state, "environment");
		assert.throws(() => service.startAuth(providerId, "api_key"), /not supported/);
		assert.throws(() => service.startAuth(providerId, "oauth"), /not supported/);
	});

	it("bridges select, text, manual code, browser/device/info/progress without modifying URLs", async (t) => {
		const { service, state } = await setup(t);
		const exactUrl = "https://login.example.invalid/authorize?state=exact%2Bstate&client_id=pi";
		const answers: string[] = [];
		state.login = async (interaction) => {
			interaction.notify({
				type: "info",
				message: "Read this",
				links: [{ url: "javascript:alert(1)" }, { url: "https://docs.example.invalid", label: "Help" }],
			});
			interaction.notify({ type: "auth_url", url: "https://secret:password@example.invalid" });
			interaction.notify({ type: "auth_url", url: exactUrl, instructions: "Choose your account" });
			answers.push(
				await interaction.prompt({
					type: "select",
					message: "Choose flow",
					options: [{ id: "device", label: "Use device", description: "On another browser" }],
				}),
			);
			interaction.notify({
				type: "device_code",
				userCode: "TEST-CODE",
				verificationUri: "https://login.example.invalid/device",
				expiresInSeconds: 120,
			});
			answers.push(
				await interaction.prompt({ type: "text", message: "Workspace", placeholder: "optional workspace" }),
			);
			answers.push(await interaction.prompt({ type: "manual_code", message: "Paste the callback URL" }));
			interaction.notify({ type: "progress", message: "Finishing" });
			return nextCredential;
		};
		const started = service.startAuth(providerId, "oauth");
		let waiting = await waitOperation(service, started.id, (operation) => operation.prompts[0]?.type === "select");
		assert.equal(waiting.state, "waiting_browser");
		assert.deepEqual(
			waiting.events.filter((event) => event.type === "auth_url"),
			[{ type: "auth_url", url: exactUrl, instructions: "Choose your account" }],
		);
		assert.equal(JSON.stringify(waiting).includes("javascript:"), false);
		assert.throws(() => service.answerAuth(started.id, waiting.prompts[0]!.id, "invented"), /options supplied by Pi/);
		service.answerAuth(started.id, waiting.prompts[0]!.id, "device");
		waiting = await waitOperation(service, started.id, (operation) => operation.prompts[0]?.type === "text");
		assert.equal(waiting.state, "waiting_device");
		const device = waiting.events.find((event) => event.type === "device_code");
		assert.ok(device?.type === "device_code" && device.expiresAt && Date.parse(device.expiresAt) > Date.now());
		service.answerAuth(started.id, waiting.prompts[0]!.id, "workspace-name");
		waiting = await waitOperation(service, started.id, (operation) => operation.prompts[0]?.type === "manual_code");
		service.answerAuth(started.id, waiting.prompts[0]!.id, "https://localhost/callback?code=manual-private-code");
		const done = await waitOperation(service, started.id, (operation) => operation.done);
		assert.equal(done.state, "connected");
		assert.deepEqual(answers, ["device", "workspace-name", "https://localhost/callback?code=manual-private-code"]);
		assert.deepEqual(done.events, []);
		assert.deepEqual(done.prompts, []);
		assert.equal(JSON.stringify(done).includes("manual-private-code"), false);
	});

	it("removes an aborted individual prompt while a different prompt and login remain active", async (t) => {
		const { service, state } = await setup(t);
		const promptController = new AbortController();
		let promptAborted = false;
		state.login = async (interaction) => {
			const manual = interaction
				.prompt({ type: "manual_code", message: "Optional callback", signal: promptController.signal })
				.catch(() => {
					promptAborted = true;
				});
			await interaction.prompt({ type: "text", message: "Still needed" });
			await manual;
			return nextCredential;
		};
		const start = service.startAuth(providerId, "oauth");
		await waitOperation(service, start.id, (operation) => operation.prompts.length === 2);
		promptController.abort();
		const remaining = await waitOperation(service, start.id, (operation) => operation.prompts.length === 1);
		assert.equal(remaining.done, false);
		assert.equal(remaining.prompts[0]!.type, "text");
		service.answerAuth(start.id, remaining.prompts[0]!.id, "continue");
		assert.equal((await waitOperation(service, start.id, (operation) => operation.done)).state, "connected");
		assert.equal(promptAborted, true);
	});

	it("preserves previous credentials across cancellation/failure, replaces only on success, and continues without login", async (t) => {
		const { service, state, store } = await setup(t);
		await store.modify(providerId, async () => oldCredential);
		state.login = async (interaction) => {
			await interaction.prompt({ type: "manual_code", message: "Code" });
			return nextCredential;
		};
		const start = service.startAuth(providerId, "oauth");
		await waitOperation(service, start.id, (operation) => operation.prompts.length > 0);
		assert.deepEqual(await store.read(providerId), oldCredential);
		assert.equal((await service.cancelAuth(start.id)).state, "cancelled");
		assert.deepEqual(await store.read(providerId), oldCredential);
		state.login = async () => {
			throw new Error(`remote response ${nextCredential.access} ${nextCredential.refresh}`);
		};
		const fail = service.startAuth(providerId, "oauth");
		const failed = await waitOperation(service, fail.id, (operation) => operation.done);
		assert.equal(failed.state, "failed");
		assert.equal(JSON.stringify(failed).includes(nextCredential.access), false);
		assert.deepEqual(await store.read(providerId), oldCredential);
		state.login = async () => nextCredential;
		const success = service.startAuth(providerId, "oauth");
		assert.equal((await waitOperation(service, success.id, (operation) => operation.done)).state, "connected");
		assert.deepEqual(await store.read(providerId), nextCredential);
		const logins = state.loginCount;
		await service.continue(providerId);
		assert.equal(state.loginCount, logins);
		assert.ok(state.networkRefreshes >= 2);
	});

	it("does not report cancellation once Pi has committed a new credential", async (t) => {
		const backing = new InMemoryCredentialStore();
		await backing.modify(providerId, async () => oldCredential);
		const committed = deferred<void>();
		const release = deferred<void>();
		const store: CredentialStore = {
			read: (id, options) => backing.read(id, options),
			list: (options) => backing.list(options),
			delete: (id, options) => backing.delete(id, options),
			modify: async (id, fn, options) => {
				const value = await backing.modify(id, fn, options);
				committed.resolve();
				await release.promise;
				return value;
			},
		};
		const { service } = await setup(t, { store });
		const operation = service.startAuth(providerId, "oauth");
		await committed.promise;
		let settled = false;
		const cancelled = service.cancelAuth(operation.id).then((value) => {
			settled = true;
			return value;
		});
		await delay(0);
		assert.equal(settled, false);
		release.resolve();
		const result = await cancelled;
		assert.equal(result.state, "connected");
		assert.match(result.message, /saved/);
		assert.deepEqual(await backing.read(providerId), nextCredential);
		assert.equal(JSON.stringify(result).includes(nextCredential.access), false);
	});

	it("checks cancellation before a queued credential mutation commits", async (t) => {
		const backing = new InMemoryCredentialStore();
		await backing.modify(providerId, async () => oldCredential);
		const entered = deferred<void>();
		const release = deferred<void>();
		const store: CredentialStore = {
			read: (id, options) => backing.read(id, options),
			list: (options) => backing.list(options),
			delete: (id, options) => backing.delete(id, options),
			modify: async (id, fn, options) => {
				entered.resolve();
				await release.promise;
				return backing.modify(id, fn, options);
			},
		};
		const { service } = await setup(t, { store });
		const operation = service.startAuth(providerId, "oauth");
		await entered.promise;
		const cancellation = service.cancelAuth(operation.id);
		release.resolve();
		assert.equal((await cancellation).state, "cancelled");
		assert.deepEqual(await backing.read(providerId), oldCredential);
	});

	it("reports a committed connection when Pi's post-login catalog synchronization fails", async (t) => {
		const { service, state, store } = await setup(t);
		await store.modify(providerId, async () => oldCredential);
		state.failSync = true;
		const started = service.startAuth(providerId, "oauth");
		const done = await waitOperation(service, started.id, (operation) => operation.done);
		assert.equal(done.state, "connected");
		assert.match(done.message, /saved/);
		assert.doesNotMatch(done.message, /previously saved connection was preserved/);
		assert.equal(JSON.stringify(done).includes(nextCredential.refresh), false);
		assert.deepEqual(await store.read(providerId), nextCredential);
	});

	it("retains available cached models on catalog failure and reports OAuth refresh reconnection truthfully", async (t) => {
		const { service, state, store } = await setup(t);
		await store.modify(providerId, async () => oldCredential);
		state.failCatalog = true;
		let catalog = await service.continue(providerId);
		assert.equal(catalog.providers.find((provider) => provider.id === providerId)!.state, "offline_cached");
		assert.ok(catalog.models.some((model) => model.provider === providerId));
		await store.modify(providerId, async () => ({ ...oldCredential, expires: 1 }));
		state.failRefresh = true;
		catalog = await service.continue(providerId);
		assert.equal(catalog.providers.find((provider) => provider.id === providerId)!.state, "reconnect_required");
		assert.ok(state.refreshCount > 0);
		assert.equal(JSON.stringify(catalog).includes(oldCredential.access), false);
		assert.equal((await store.read(providerId))?.type, "oauth");
	});

	it("disconnects Pi's saved credential while retaining truthful ambient availability", async (t) => {
		const { service, state, store } = await setup(t);
		await answerKey(service, "literal-saved-key");
		state.ambient = true;
		const summary = (await service.disconnect(providerId)).providers.find((provider) => provider.id === providerId)!;
		assert.equal(await store.read(providerId), undefined);
		assert.equal(summary.state, "environment");
		assert.equal(summary.source, "environment");
		assert.equal(summary.storedAuthType, null);
		assert.equal(summary.modelCount, 1);
	});

	it("persists Pi-managed keys and a stable login installation UUID across restart", async (t) => {
		const { service, dir, state, provider } = await setup(t, { persistent: true });
		const ids: string[] = [];
		state.login = async (_interaction, options) => {
			assert.equal(options?.agentName, "Data Pi");
			ids.push(options!.getDeviceId!());
			return nextCredential;
		};
		let operation = service.startAuth(providerId, "oauth");
		await waitOperation(service, operation.id, (value) => value.done);
		await answerKey(service, "persistent-literal-key");
		await service.close();
		const reopened = await ProviderService.create(dir);
		t.after(() => reopened.close());
		reopened.runtime.registerNativeProvider(provider);
		assert.equal((await reopened.runtime.checkAuth(providerId))?.type, "api_key");
		assert.equal(
			(await reopened.catalog()).providers.find((entry) => entry.id === providerId)!.storedAuthType,
			"api_key",
		);
		operation = reopened.startAuth(providerId, "oauth");
		await waitOperation(reopened, operation.id, (value) => value.done);
		assert.equal(ids.length, 2);
		assert.equal(ids[0], ids[1]);
		assert.match(ids[0]!, /^[0-9a-f-]{36}$/u);
		const authFile = JSON.parse(await readFile(join(dir, "pi", "auth.json"), "utf8")) as Record<
			string,
			{ type: string }
		>;
		assert.equal(authFile[providerId]!.type, "oauth");
		await reopened.close();
	});

	it("rejects executable credential input without running it or echoing secrets", async (t) => {
		const { service, dir } = await setup(t, { persistent: true });
		const marker = join(dir, "must-not-exist");
		const operation = service.startAuth(providerId, "api_key");
		const waiting = await waitOperation(service, operation.id, (value) => value.prompts.length > 0);
		for (const unsafe of [
			`!echo private-command > "${marker}"`,
			"$PATH",
			`\${PRIVATE_KEY}`,
			"key\nwith-control",
			"`command`",
			"x".repeat(16 * 1024 + 1),
		]) {
			assert.throws(
				() => service.answerAuth(operation.id, waiting.prompts[0]!.id, unsafe),
				(error: unknown) => error instanceof Error && !error.message.includes(unsafe),
			);
		}
		await assert.rejects(access(marker));
		service.answerAuth(operation.id, waiting.prompts[0]!.id, "literal-private-key");
		const done = await waitOperation(service, operation.id, (value) => value.done);
		assert.equal(done.state, "connected");
		assert.equal(JSON.stringify(done).includes("literal-private-key"), false);
		assert.equal(JSON.stringify(await service.catalog()).includes("literal-private-key"), false);
	});

	it("bounds stalled flows and cancellation rejects every pending prompt", async (t) => {
		const { service, state, store } = await setup(t, { authTimeoutMs: 30 });
		await store.modify(providerId, async () => oldCredential);
		let rejected = 0;
		state.login = async (interaction) => {
			await Promise.all(
				["First", "Second"].map((message) =>
					interaction.prompt({ type: "text", message }).catch(() => {
						rejected++;
					}),
				),
			);
			return nextCredential;
		};
		const operation = service.startAuth(providerId, "oauth");
		const done = await waitOperation(service, operation.id, (value) => value.done);
		assert.equal(done.state, "cancelled");
		assert.equal(rejected, 2);
		assert.deepEqual(done.prompts, []);
		assert.deepEqual(await store.read(providerId), oldCredential);
	});
});
