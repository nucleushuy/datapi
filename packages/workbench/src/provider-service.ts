import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type Api,
	type AuthCheck,
	type AuthEvent,
	type AuthPrompt,
	getSupportedThinkingLevels,
	type Model,
	ModelsError,
	type Provider,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	CredentialSynchronizationError,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ProviderAuthEvent,
	ProviderAuthOperation,
	ProviderAuthPrompt,
	ProviderAuthType,
	ProviderCatalog,
	ProviderModel,
	ProviderSummary,
	SessionModelState,
} from "./provider-contracts.ts";
import { registerAutoModel } from "./provider-router.ts";
import { WorkbenchError } from "./storage.ts";

export const PROVIDER_GUIDANCE =
	"Models and authentication methods come from Pi. A configured connection is not proof of a verified identity, valid API key, or model entitlement. Auto can send approved conversation context to any compatible configured provider.";
const MAX_OPERATIONS = 64;
const MAX_ACTIVE = 16;
const RETENTION_MS = 5 * 60_000;
const MAX_ANSWER = 16 * 1024;
const connectedMessage =
	"Connection configured through Pi. Identity and credential validity have not been independently verified.";
const savedWarning =
	"The new connection was saved. Pi could not synchronize its catalog; refresh the provider before selecting a model.";

type PendingPrompt = { dto: ProviderAuthPrompt; resolve(value: string): void; reject(): void };
type Operation = {
	dto: ProviderAuthOperation;
	controller: AbortController;
	prompts: Map<string, PendingPrompt>;
	answers: string[];
	promptCount: number;
	completion: Promise<void>;
	expiresAt: number;
	timer: ReturnType<typeof setTimeout>;
};
export interface ProviderServiceOptions {
	/** Inject a real Pi runtime with deterministic native providers; never a second frontend registry. */
	runtime?: ModelRuntime;
	authTimeoutMs?: number;
	refreshTimeoutMs?: number;
}

function safeUrl(value: string): string | undefined {
	if (value.length > 16_384) return undefined;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
			? value
			: undefined;
	} catch {
		return undefined;
	}
}
function safeText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 4096);
}
function transientText(operation: Operation, value: string): string {
	let result = value;
	for (const answer of operation.answers) result = result.replaceAll(answer, "[redacted]");
	return safeText(result);
}
function transientUrl(operation: Operation, value: string): string | undefined {
	return operation.answers.some((answer) => value.includes(answer)) ? undefined : safeUrl(value);
}
function abortError(): DOMException {
	return new DOMException("Authentication cancelled.", "AbortError");
}

export class ProviderService {
	readonly runtime: ModelRuntime;
	readonly settings: SettingsManager;
	readonly agentDir: string;
	readonly #deviceId: string;
	readonly #authTimeoutMs: number;
	readonly #refreshTimeoutMs: number;
	readonly #operations = new Map<string, Operation>();
	readonly #active = new Map<string, Operation>();
	readonly #busy = new Set<string>();
	readonly #offline = new Set<string>();
	readonly #reconnect = new Set<string>();
	readonly #shutdown = new AbortController();
	#closePromise: Promise<void> | undefined;

	private constructor(
		runtime: ModelRuntime,
		settings: SettingsManager,
		agentDir: string,
		deviceId: string,
		options: ProviderServiceOptions,
	) {
		this.runtime = runtime;
		this.settings = settings;
		this.agentDir = agentDir;
		this.#deviceId = deviceId;
		this.#authTimeoutMs = options.authTimeoutMs ?? 10 * 60_000;
		this.#refreshTimeoutMs = options.refreshTimeoutMs ?? 15_000;
		registerAutoModel(runtime);
	}

	static async create(dataDir: string, options: ProviderServiceOptions = {}): Promise<ProviderService> {
		try {
			const agentDir = join(dataDir, "pi");
			await mkdir(agentDir, { recursive: true, mode: 0o700 });
			const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
			settings.applyOverrides({
				compaction: { enabled: false },
				retry: { enabled: false, provider: { maxRetries: 0 } },
				transport: "sse",
				cacheWarming: "off",
				enableInstallTelemetry: false,
				enableAnalytics: false,
				enableSkillCommands: false,
				images: { autoResize: false },
			});
			const deviceId = settings.getOrCreateDeviceId();
			await settings.flush();
			if (
				settings.drainErrors().length ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(deviceId)
			)
				throw new Error("Invalid profile settings");
			const runtime =
				options.runtime ??
				(await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					modelsStorePath: join(agentDir, "models-store.json"),
					allowModelNetwork: false,
					signal: AbortSignal.timeout(options.refreshTimeoutMs ?? 15_000),
				}));
			return new ProviderService(runtime, settings, agentDir, deviceId, options);
		} catch {
			throw new WorkbenchError(503, "Pi provider settings could not be opened for this profile.");
		}
	}

	#assertOpen(): void {
		if (this.#shutdown.signal.aborted) throw new WorkbenchError(503, "Provider service is closed.");
	}
	#provider(providerId: string): Provider {
		this.#assertOpen();
		const provider = this.runtime.getProvider(providerId);
		if (!provider) throw new WorkbenchError(404, "Provider is no longer available in Pi.");
		return provider;
	}
	#signal(): AbortSignal {
		return AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(this.#refreshTimeoutMs)]);
	}
	#prune(): void {
		for (const [id, operation] of this.#operations) {
			if (operation.dto.done && operation.expiresAt <= Date.now()) this.#operations.delete(id);
		}
		while (this.#operations.size >= MAX_OPERATIONS) {
			const removable = [...this.#operations].find(([, operation]) => operation.dto.done);
			if (!removable) break;
			this.#operations.delete(removable[0]);
		}
	}

	#model(model: Model<Api>): ProviderModel {
		const virtual = model.api === "pi-virtual";
		return {
			provider: model.provider,
			id: model.id,
			name: model.name.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 512) || model.id,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			input: model.input.filter((input): input is "text" | "image" => input === "text" || input === "image"),
			reasoning: model.reasoning,
			thinkingLevels: getSupportedThinkingLevels(model),
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			billing: virtual ? "virtual" : this.runtime.isUsingSubscription(model.provider) ? "subscription" : "api",
			virtual,
		};
	}

	async catalog(): Promise<ProviderCatalog> {
		this.#assertOpen();
		const signal = this.#signal();
		try {
			const providers = this.runtime.getProviders();
			const credentials = await this.runtime.listCredentials({ signal });
			const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
			// Populate Pi's authoritative snapshot; one broken provider must not hide unrelated connections.
			let available: readonly Model<Api>[];
			try {
				available = await this.runtime.getAvailable(undefined, { signal });
			} catch {
				signal.throwIfAborted();
				available = (
					await Promise.all(
						providers.map(async (provider) => {
							try {
								return await this.runtime.getAvailable(provider.id, { signal });
							} catch {
								return [];
							}
						}),
					)
				).flat();
			}
			const models = available.map((model) => this.#model(model));
			const summaries = await Promise.all(
				providers.map(async (provider): Promise<ProviderSummary> => {
					let check: AuthCheck | undefined;
					let checkFailed = false;
					try {
						check = await this.runtime.checkAuth(provider.id, { signal });
					} catch {
						checkFailed = true;
					}
					const status = this.runtime.getProviderAuthStatus(provider.id);
					const storedAuthType = stored.get(provider.id) ?? null;
					const virtual = check?.source === "virtual";
					const configured = check !== undefined;
					const source: ProviderSummary["source"] = !configured
						? null
						: virtual
							? "virtual"
							: status.source === "runtime"
								? "runtime"
								: storedAuthType
									? "stored"
									: check?.type === "api_key"
										? "environment"
										: status.source === "environment"
											? "environment"
											: "configuration";
					const modelCount = models.filter((model) => model.provider === provider.id).length;
					const active = this.#active.get(provider.id);
					const needsReconnect = checkFailed || this.#reconnect.has(provider.id);
					const state =
						active?.dto.state ??
						(needsReconnect
							? "reconnect_required"
							: !configured
								? "disconnected"
								: this.#offline.has(provider.id) && modelCount > 0
									? "offline_cached"
									: source === "environment"
										? "environment"
										: "connected");
					const message =
						active?.dto.message ??
						(needsReconnect
							? "Pi could not resolve this connection. Refresh or reconnect it."
							: !configured
								? "No connection is configured."
								: state === "offline_cached"
									? "Catalog refresh is unavailable; showing Pi's cached available models."
									: source === "environment"
										? "Available through environment configuration. Disconnecting cannot remove ambient credentials."
										: virtual
											? "Routes only to compatible physical models available through Pi."
											: connectedMessage);
					return {
						id: provider.id,
						name: provider.name,
						auth: {
							oauth: provider.auth.oauth
								? {
										label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
										subscription: provider.auth.oauth.isSubscription === true,
									}
								: null,
							apiKey: provider.auth.apiKey
								? {
										label: provider.auth.apiKey.name,
										interactive: typeof provider.auth.apiKey.login === "function",
									}
								: null,
						},
						state,
						configured,
						authType: virtual ? null : (check?.type ?? null),
						storedAuthType,
						source,
						modelCount,
						message,
					};
				}),
			);
			signal.throwIfAborted();
			return { providers: summaries, models, guidance: PROVIDER_GUIDANCE };
		} catch {
			throw new WorkbenchError(503, "Pi provider configuration could not be read. Try again.");
		}
	}

	async models(): Promise<ProviderModel[]> {
		this.#assertOpen();
		try {
			return (await this.runtime.getAvailable(undefined, { signal: this.#signal() })).map((model) =>
				this.#model(model),
			);
		} catch {
			throw new WorkbenchError(503, "Pi's available models could not be read. Check provider connections.");
		}
	}

	modelState(session: AgentSession): SessionModelState {
		const routed = session.routedModel;
		return {
			model: session.model ? this.#model(session.model) : null,
			thinkingLevel: session.thinkingLevel,
			routedModel: routed
				? {
						provider: routed.model.provider,
						id: routed.model.id,
						name: routed.model.name.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 512) || routed.model.id,
						...(routed.thinkingLevel ? { thinkingLevel: routed.thinkingLevel } : {}),
					}
				: null,
		};
	}

	async #refresh(providerId: string, operationSignal?: AbortSignal): Promise<boolean> {
		try {
			const signal = operationSignal ? AbortSignal.any([operationSignal, this.#signal()]) : this.#signal();
			const result = await this.runtime.refresh({ providers: [providerId], allowNetwork: true, signal });
			if (result.aborted || result.errors.has(providerId)) throw new Error("Catalog refresh unavailable");
			this.#offline.delete(providerId);
			return true;
		} catch {
			this.#offline.add(providerId);
			return false;
		}
	}

	async continue(providerId: string): Promise<ProviderCatalog> {
		this.#provider(providerId);
		if (this.#active.has(providerId) || this.#busy.has(providerId))
			throw new WorkbenchError(409, "A provider connection operation is already running.");
		this.#busy.add(providerId);
		try {
			let check: AuthCheck | undefined;
			try {
				check = await this.runtime.checkAuth(providerId, { signal: this.#signal() });
			} catch {
				throw new WorkbenchError(503, "Pi could not check this connection. Try reconnecting.");
			}
			if (!check)
				throw new WorkbenchError(409, "No configured connection is available. Connect this provider first.");
			try {
				// Request auth is server-only. Pi refreshes expiring OAuth credentials under its store lock.
				if (!(await this.runtime.getAuth(providerId, { signal: this.#signal() }))) {
					this.#reconnect.add(providerId);
					return await this.catalog();
				}
				this.#reconnect.delete(providerId);
			} catch (error) {
				if (error instanceof ModelsError && (error.code === "oauth" || error.code === "auth")) {
					this.#reconnect.add(providerId);
					return await this.catalog();
				}
				throw new WorkbenchError(503, "Pi could not resolve this connection. Try again or reconnect.");
			}
			await this.#refresh(providerId);
			return await this.catalog();
		} finally {
			this.#busy.delete(providerId);
		}
	}

	async disconnect(providerId: string): Promise<ProviderCatalog> {
		this.#provider(providerId);
		if (this.#busy.has(providerId))
			throw new WorkbenchError(409, "A provider connection operation is already running.");
		this.#busy.add(providerId);
		try {
			const active = this.#active.get(providerId);
			if (active) await this.cancelAuth(active.dto.id);
			try {
				await this.runtime.logout(providerId, { signal: this.#signal() });
			} catch (error) {
				if (!(error instanceof CredentialSynchronizationError && error.operation === "logout"))
					throw new WorkbenchError(503, "Pi could not remove the saved connection. Try again.");
			}
			this.#offline.delete(providerId);
			this.#reconnect.delete(providerId);
			return await this.catalog();
		} finally {
			this.#busy.delete(providerId);
		}
	}

	startAuth(providerId: string, type: ProviderAuthType): ProviderAuthOperation {
		const provider = this.#provider(providerId);
		const method = type === "oauth" ? provider.auth.oauth : type === "api_key" ? provider.auth.apiKey : undefined;
		if (!method?.login)
			throw new WorkbenchError(400, "This authentication method is not supported by this Pi provider.");
		if (this.#active.has(providerId) || this.#busy.has(providerId))
			throw new WorkbenchError(409, "A provider connection operation is already running.");
		this.#prune();
		if (this.#active.size >= MAX_ACTIVE || this.#operations.size >= MAX_OPERATIONS)
			throw new WorkbenchError(429, "Too many authentication operations are active. Finish or cancel one first.");
		const controller = new AbortController();
		const id = randomUUID();
		const operation: Operation = {
			dto: {
				id,
				providerId,
				authType: type,
				state: "connecting",
				done: false,
				message: "Starting authentication through Pi…",
				prompts: [],
				events: [],
			},
			controller,
			prompts: new Map(),
			answers: [],
			promptCount: 0,
			completion: Promise.resolve(),
			expiresAt: Infinity,
			timer: setTimeout(() => controller.abort(abortError()), this.#authTimeoutMs),
		};
		operation.timer.unref?.();
		this.#operations.set(id, operation);
		this.#active.set(providerId, operation);
		operation.completion = this.#login(operation);
		return this.#snapshot(operation);
	}

	async #login(operation: Operation): Promise<void> {
		let committed = false;
		try {
			let synchronized = true;
			try {
				// Pi owns one stored credential per provider. Do not logout before switching.
				await this.runtime.login(
					operation.dto.providerId,
					operation.dto.authType,
					{
						signal: operation.controller.signal,
						prompt: (prompt) => this.#prompt(operation, prompt),
						notify: (event) => this.#notify(operation, event),
					},
					{ agentName: "Data Pi", getDeviceId: () => this.#deviceId },
				);
				committed = true;
			} catch (error) {
				if (!(error instanceof CredentialSynchronizationError && error.operation === "login")) throw error;
				// The credential committed: cancellation or synchronization failure cannot undo it.
				committed = true;
				synchronized = false;
				this.#offline.add(operation.dto.providerId);
			}
			operation.dto.state = "verifying";
			operation.dto.message = "Connection saved. Refreshing Pi's available models…";
			const refreshed = operation.controller.signal.aborted
				? false
				: await this.#refresh(operation.dto.providerId, operation.controller.signal);
			const check = await this.runtime.checkAuth(operation.dto.providerId, { signal: this.#signal() });
			if (!check) {
				this.#reconnect.add(operation.dto.providerId);
				operation.dto.state = "reconnect_required";
				operation.dto.message =
					"Pi saved the credential but does not report a configured connection. Reconnect this provider.";
			} else {
				this.#reconnect.delete(operation.dto.providerId);
				operation.dto.state = "connected";
				operation.dto.message = synchronized && refreshed ? connectedMessage : savedWarning;
			}
		} catch {
			operation.dto.state = committed ? "connected" : operation.controller.signal.aborted ? "cancelled" : "failed";
			operation.dto.message = committed
				? savedWarning
				: operation.controller.signal.aborted
					? "Authentication cancelled. Any previously saved connection was preserved."
					: "Authentication failed. Any previously saved connection was preserved. Try again on the provider's page.";
		} finally {
			clearTimeout(operation.timer);
			for (const prompt of operation.prompts.values()) prompt.reject();
			operation.prompts.clear();
			operation.answers.length = 0;
			// Authorization links/codes are only transient UI data, never retained terminal history.
			operation.dto.events = [];
			operation.dto.done = true;
			operation.expiresAt = Date.now() + RETENTION_MS;
			this.#active.delete(operation.dto.providerId);
		}
	}

	#prompt(operation: Operation, prompt: AuthPrompt): Promise<string> {
		if (operation.controller.signal.aborted || prompt.signal?.aborted || operation.dto.done)
			return Promise.reject(abortError());
		if (operation.prompts.size >= 8 || ++operation.promptCount > 64)
			return Promise.reject(new Error("Too many authentication prompts"));
		const id = randomUUID();
		const message = transientText(operation, prompt.message);
		const dto: ProviderAuthPrompt =
			prompt.type === "select"
				? {
						id,
						type: prompt.type,
						message,
						options: prompt.options.slice(0, 100).map((option) => ({
							id: option.id,
							label: transientText(operation, option.label),
							...(option.description ? { description: transientText(operation, option.description) } : {}),
						})),
					}
				: {
						id,
						type: prompt.type,
						message,
						...(prompt.placeholder ? { placeholder: transientText(operation, prompt.placeholder) } : {}),
					};
		if (prompt.type === "manual_code") operation.dto.state = "waiting_browser";
		operation.dto.message = "Complete the authentication step requested by Pi.";
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				operation.prompts.delete(id);
				operation.controller.signal.removeEventListener("abort", cancel);
				prompt.signal?.removeEventListener("abort", cancel);
			};
			const cancel = () => {
				cleanup();
				reject(abortError());
			};
			operation.prompts.set(id, {
				dto,
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: cancel,
			});
			operation.controller.signal.addEventListener("abort", cancel, { once: true });
			prompt.signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	#notify(operation: Operation, event: AuthEvent): void {
		if (operation.dto.done || operation.controller.signal.aborted) return;
		let dto: ProviderAuthEvent;
		switch (event.type) {
			case "auth_url": {
				const url = transientUrl(operation, event.url);
				if (!url) return;
				dto = {
					type: "auth_url",
					url,
					...(event.instructions ? { instructions: transientText(operation, event.instructions) } : {}),
				};
				operation.dto.state = "waiting_browser";
				operation.dto.message = "Waiting for authentication on the provider's page…";
				break;
			}
			case "device_code": {
				const verificationUri = transientUrl(operation, event.verificationUri);
				if (!verificationUri) return;
				const expires = event.expiresInSeconds;
				dto = {
					type: "device_code",
					userCode: transientText(operation, event.userCode),
					verificationUri,
					...(expires !== undefined && Number.isFinite(expires) && expires >= 0 && expires <= 86400
						? { expiresAt: new Date(Date.now() + expires * 1000).toISOString() }
						: {}),
				};
				operation.dto.state = "waiting_device";
				operation.dto.message = "Waiting for device-code confirmation on the provider's page…";
				break;
			}
			case "info": {
				const links = event.links
					?.flatMap((link) => {
						const url = transientUrl(operation, link.url);
						return url ? [{ url, ...(link.label ? { label: transientText(operation, link.label) } : {}) }] : [];
					})
					.slice(0, 16);
				dto = {
					type: "info",
					message: transientText(operation, event.message),
					...(links?.length ? { links } : {}),
				};
				break;
			}
			case "progress":
				dto = { type: "progress", message: transientText(operation, event.message) };
				operation.dto.state = "verifying";
				operation.dto.message = "Pi is completing authentication…";
				break;
		}
		operation.dto.events.push(dto);
		if (operation.dto.events.length > 32) operation.dto.events.shift();
	}

	#operation(id: string): Operation {
		this.#prune();
		const operation = this.#operations.get(id);
		if (!operation) throw new WorkbenchError(404, "Authentication operation expired or was not found.");
		return operation;
	}
	#snapshot(operation: Operation): ProviderAuthOperation {
		return structuredClone({
			...operation.dto,
			prompts: [...operation.prompts.values()].map((prompt) => prompt.dto),
		});
	}
	authOperation(id: string): ProviderAuthOperation {
		return this.#snapshot(this.#operation(id));
	}
	answerAuth(id: string, promptId: string, value: string): void {
		this.#assertOpen();
		const operation = this.#operation(id);
		const prompt = operation.prompts.get(promptId);
		if (operation.dto.done || !prompt)
			throw new WorkbenchError(409, "This authentication prompt is no longer active.");
		if (typeof value !== "string" || value.length > MAX_ANSWER || value.includes("\0"))
			throw new WorkbenchError(400, "Authentication response is invalid or too long.");
		if (prompt.dto.type === "select" && !prompt.dto.options.some((option) => option.id === value))
			throw new WorkbenchError(400, "Choose one of the options supplied by Pi.");
		// Pi auth.json supports executable configuration. Web-entered keys must remain literal.
		if (
			(prompt.dto.type === "secret" || operation.dto.authType === "api_key") &&
			(/^[\s]*!/u.test(value) || /[$`\u0000-\u001f\u007f]/u.test(value))
		)
			throw new WorkbenchError(400, "Enter a literal credential, not a command or environment reference.");
		if (value && prompt.dto.type !== "select") operation.answers.push(value);
		prompt.resolve(value);
	}
	async cancelAuth(id: string): Promise<ProviderAuthOperation> {
		const operation = this.#operation(id);
		if (!operation.dto.done) operation.controller.abort(abortError());
		// Pi waits for an in-flight credential mutation. Never report cancellation before commit settles.
		await operation.completion;
		return this.#snapshot(operation);
	}
	close(): Promise<void> {
		if (!this.#closePromise) {
			this.#shutdown.abort();
			for (const operation of this.#active.values()) operation.controller.abort(abortError());
			this.#closePromise = (async () => {
				await Promise.all([...this.#operations.values()].map((operation) => operation.completion));
				this.#operations.clear();
				await this.settings.flush();
				if (this.settings.drainErrors().length)
					throw new WorkbenchError(503, "Pi profile settings could not be saved.");
			})();
		}
		return this.#closePromise;
	}
}
