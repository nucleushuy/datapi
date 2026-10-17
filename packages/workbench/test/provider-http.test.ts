import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthOperation, ProviderCatalog, SessionModelState } from "../src/provider-contracts.ts";
import { ProviderService } from "../src/provider-service.ts";
import { startWorkbench } from "../src/server.ts";
import { createAuthTestProvider } from "./fixtures/provider-auth.ts";

test(
	"HTTP provider discovery, Pi login, model selection, cancellation and safe responses",
	{ timeout: 60000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "datapi-provider-http-"));
		const credentials = new InMemoryCredentialStore();
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const fixture = createAuthTestProvider();
		runtime.registerNativeProvider(fixture.provider);
		await runtime.refresh({ providers: [fixture.provider.id], allowNetwork: false });
		const providers = await ProviderService.create(directory, { runtime });
		const app = await startWorkbench({ dataDir: directory, port: 0, providers });
		t.after(async () => {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		});
		const bootstrap = (await fetch(`${app.url}/api/bootstrap`).then((response) => response.json())) as {
			token: string;
		};
		const bodies: string[] = [];
		async function request<T>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> {
			const response = await fetch(`${app.url}${path}`, {
				method,
				headers: {
					"x-workbench-token": bootstrap.token,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const text = await response.text();
			bodies.push(text);
			assert.equal(response.status, status, text);
			return JSON.parse(text) as T;
		}
		async function waitOperation(id: string, predicate: (value: ProviderAuthOperation) => boolean) {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				const operation = await request<ProviderAuthOperation>(`/api/provider-auth/${id}`);
				if (predicate(operation)) return operation;
				await nextTick();
			}
			throw new Error("Pi authentication operation did not reach expected state");
		}
		const before = await request<ProviderCatalog>("/api/providers");
		assert.deepEqual(
			new Set(before.providers.map((provider) => provider.id)),
			new Set(runtime.getProviders().map((provider) => provider.id)),
		);
		const row = before.providers.find((provider) => provider.id === fixture.provider.id);
		assert.equal(row?.name, fixture.provider.name);
		assert.equal(row?.auth.oauth?.label, "Sign in with Future Test");
		assert.equal(row?.auth.apiKey?.interactive, true);
		assert.equal(
			before.models.some((model) => model.provider === fixture.provider.id),
			false,
		);
		assert.equal((await fetch(`${app.url}/api/providers`)).status, 403);
		assert.equal(
			(
				await fetch(`${app.url}/api/providers`, {
					headers: { "x-workbench-token": bootstrap.token, origin: "https://example.invalid" },
				})
			).status,
			403,
		);
		await request(
			"/api/chat/credentials",
			"POST",
			{ provider: fixture.provider.id, apiKey: "never-saved-secret" },
			404,
		);
		await request(`/api/providers/${fixture.provider.id}/auth`, "POST", { type: "password" }, 400);
		const keyLogin = await request<ProviderAuthOperation>(
			`/api/providers/${fixture.provider.id}/auth`,
			"POST",
			{ type: "api_key" },
			201,
		);
		const prompted = await waitOperation(keyLogin.id, (value) =>
			value.prompts.some((prompt) => prompt.type === "secret"),
		);
		const prompt = prompted.prompts.find((item) => item.type === "secret");
		assert.ok(prompt);
		await request(`/api/provider-auth/${keyLogin.id}`, "POST", {
			promptId: prompt.id,
			value: "literal-key-not-a-real-secret",
		});
		await waitOperation(keyLogin.id, (value) => value.done);
		assert.equal((await credentials.read(fixture.provider.id))?.type, "api_key");
		const catalog = await request<ProviderCatalog>(`/api/providers/${fixture.provider.id}/continue`, "POST");
		assert.equal(fixture.counters.key, 1, "Continue must not restart login");
		assert.deepEqual(
			catalog.models
				.filter((model) => model.provider === fixture.provider.id)
				.map((model) => model.id)
				.sort(),
			["analysis-model", "image-model"],
		);
		assert.ok(fixture.counters.modelRefresh > 0);
		const selection = {
			provider: fixture.provider.id,
			modelId: "analysis-model",
			thinkingLevel: "off",
			persist: false,
		};
		const selected = await request<SessionModelState>("/api/chat/model", "PUT", selection);
		assert.equal(selected.model?.id, "analysis-model");
		assert.equal((await request<SessionModelState>("/api/chat/model")).model?.provider, fixture.provider.id);
		await request("/api/chat/model", "PUT", { ...selection, modelId: "missing-model" }, 400);
		const oauth = await request<ProviderAuthOperation>(
			`/api/providers/${fixture.provider.id}/auth`,
			"POST",
			{ type: "oauth" },
			201,
		);
		await waitOperation(oauth.id, (value) => value.prompts.length > 0);
		const cancelled = await request<ProviderAuthOperation>(`/api/provider-auth/${oauth.id}`, "DELETE");
		assert.equal(cancelled.done, true);
		assert.equal(cancelled.state, "cancelled");
		const retained = await credentials.read(fixture.provider.id);
		assert.equal(retained?.type, "api_key");
		if (retained?.type === "api_key") assert.equal(retained.key, "literal-key-not-a-real-secret");
		for (const flow of ["browser", "device"] as const) {
			const replacement = await request<ProviderAuthOperation>(
				`/api/providers/${fixture.provider.id}/auth`,
				"POST",
				{ type: "oauth" },
				201,
			);
			for (const [type, value] of [
				["text", "Local workspace"],
				["select", flow],
				["manual_code", "private-authorization-code"],
			] as const) {
				const current = await waitOperation(replacement.id, (operation) =>
					operation.prompts.some((item) => item.type === type),
				);
				const pending = current.prompts.find((item) => item.type === type);
				assert.ok(pending);
				if (type === "manual_code")
					assert.ok(
						current.events.some((event) => event.type === (flow === "browser" ? "auth_url" : "device_code")),
					);
				await request(`/api/provider-auth/${replacement.id}`, "POST", { promptId: pending.id, value });
			}
			const complete = await waitOperation(replacement.id, (operation) => operation.done);
			assert.equal(complete.state, "connected");
			assert.equal((await credentials.read(fixture.provider.id))?.type, "oauth");
		}
		const previousLogins = fixture.counters.oauth;
		await request(`/api/providers/${fixture.provider.id}/continue`, "POST");
		assert.equal(fixture.counters.oauth, previousLogins);
		fixture.setFailLogin(true);
		const failing = await request<ProviderAuthOperation>(
			`/api/providers/${fixture.provider.id}/auth`,
			"POST",
			{ type: "api_key" },
			201,
		);
		const failurePrompt = await waitOperation(failing.id, (operation) => operation.prompts.length > 0);
		await request(`/api/provider-auth/${failing.id}`, "POST", {
			promptId: failurePrompt.prompts[0].id,
			value: "failed-replacement-key",
		});
		assert.equal((await waitOperation(failing.id, (operation) => operation.done)).state, "failed");
		assert.equal(
			(await credentials.read(fixture.provider.id))?.type,
			"oauth",
			"Failed replacement must preserve OAuth credential",
		);
		fixture.setAmbient(true);
		const disconnected = await request<ProviderCatalog>(`/api/providers/${fixture.provider.id}`, "DELETE");
		assert.equal(await credentials.read(fixture.provider.id), undefined);
		const ambient = disconnected.providers.find((provider) => provider.id === fixture.provider.id);
		assert.equal(ambient?.configured, true);
		assert.equal(ambient?.state, "environment");
		for (const secret of [
			"literal-key-not-a-real-secret",
			"private-provider-header",
			"secret-access-token",
			"secret-refresh-token",
			"private-ambient-key",
			"never-saved-secret",
			"private-authorization-code",
			"failed-replacement-key",
			"private-provider-error",
		])
			assert.equal(
				bodies.some((body) => body.includes(secret)),
				false,
				`Response leaked ${secret}`,
			);
		assert.equal(fixture.faux.state.callCount, 0, "Auth and model selection must not dispatch inference");
	},
);
