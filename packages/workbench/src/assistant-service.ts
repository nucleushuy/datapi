import { createHash, randomUUID } from "node:crypto";
import { buildAssistantPayload, prepareAssistantContext } from "./assistant-context.ts";
import {
	ASSISTANT_CONTEXT_BYTES,
	ASSISTANT_OUTPUT_BYTES,
	ASSISTANT_TIMEOUT_MS,
	type AssistantChartPreview,
	type AssistantContext,
	type AssistantDraft,
	type AssistantDriver,
	type AssistantModels,
	type AssistantPayload,
	type AssistantProgress,
	type AssistantRun,
	type AssistantSuggestion,
	type AssistantUsage,
} from "./assistant-contracts.ts";
import { parseAssistantOutput, parseAssistantSelection } from "./assistant-validation.ts";
import { CHART_RESULT_BYTES } from "./chart-contracts.ts";
import type { Dataset } from "./contracts.ts";
import type { DatasetProfile } from "./profile-contracts.ts";
import { WorkbenchError, type WorkbenchStore } from "./storage.ts";

const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_DRAFTS = 10;
const MAX_PREVIEWS = 8;
const PROGRESS_INTERVAL_MS = 100;
const STALE_CONTEXT =
	"This suggestion belongs to a changed dataset or profile. Prepare and approve a new request before previewing or applying it.";
const EMPTY_USAGE: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

type ServiceStore = Pick<
	WorkbenchStore,
	| "getProject"
	| "getDataset"
	| "getProfile"
	| "listCharts"
	| "chartPreview"
	| "assistantRuns"
	| "assistantRun"
	| "putAssistantRun"
	| "applyAssistantChart"
	| "revertAssistantChart"
>;

interface StagedDraft {
	draft: AssistantDraft;
	request: string;
	profileHash: string;
	timer: NodeJS.Timeout;
}

interface ActiveGeneration {
	run: AssistantRun;
	controller: AbortController;
	task: Promise<void>;
	startedAt: number;
	receivedCharacters: number;
	usage: AssistantUsage;
	stop?: "cancelled" | "timeout" | "storage";
	finished: boolean;
	progressTimer?: NodeJS.Timeout;
	progressWrite?: Promise<void>;
	deadline?: NodeJS.Timeout;
}

interface CachedPreview {
	id: string;
	runId: string;
	suggestionId: string;
	identity: string;
	controller: AbortController;
	expiresAt: number;
	timer?: NodeJS.Timeout;
	result?: AssistantChartPreview;
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function payloadHash(provider: string, modelId: string, payload: AssistantPayload): string {
	return hash({ provider, modelId, payload });
}

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function count(value: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function mergeUsage(previous: AssistantUsage, next: AssistantUsage): AssistantUsage {
	return {
		input: Math.max(previous.input, count(next.input)),
		output: Math.max(previous.output, count(next.output)),
		cacheRead: Math.max(previous.cacheRead, count(next.cacheRead)),
		cacheWrite: Math.max(previous.cacheWrite, count(next.cacheWrite)),
		totalTokens: Math.max(previous.totalTokens, count(next.totalTokens)),
	};
}

export class AssistantService {
	readonly #store: ServiceStore;
	readonly #driver: AssistantDriver;
	readonly #drafts = new Map<string, StagedDraft>();
	readonly #previews = new Map<string, CachedPreview>();
	readonly #locks = new Map<string, Promise<void>>();
	readonly #operations = new Set<Promise<unknown>>();
	#preparing = 0;
	#starting = false;
	#active?: ActiveGeneration;
	#closing = false;
	#closeTask?: Promise<void>;

	constructor(store: ServiceStore, driver: AssistantDriver) {
		this.#store = store;
		this.#driver = driver;
	}

	#assertOpen(): void {
		if (this.#closing) throw new WorkbenchError(503, "Assistant is shutting down.");
	}

	#operation<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(new WorkbenchError(503, "Assistant is shutting down."));
		const task = operation();
		this.#operations.add(task);
		void task.then(
			() => this.#operations.delete(task),
			() => this.#operations.delete(task),
		);
		return task;
	}

	#serialized<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(runId) ?? Promise.resolve();
		const task = previous.then(operation);
		const settled = task.then(
			() => {},
			() => {},
		);
		this.#locks.set(runId, settled);
		void settled.then(() => {
			if (this.#locks.get(runId) === settled) this.#locks.delete(runId);
		});
		return task;
	}

	models(signal?: AbortSignal): Promise<AssistantModels> {
		return this.#operation(async () => {
			try {
				return await this.#driver.models(signal);
			} catch {
				throw new WorkbenchError(
					503,
					"Assistant models could not be loaded. Check the server-side provider configuration.",
				);
			}
		});
	}

	async #configured(provider: string, modelId: string): Promise<void> {
		let available: AssistantModels;
		try {
			available = await this.#driver.models();
		} catch {
			throw new WorkbenchError(
				503,
				"Assistant models could not be loaded. Check the server-side provider configuration.",
			);
		}
		if (!available.models.some((model) => model.provider === provider && model.id === modelId && model.configured))
			throw new WorkbenchError(
				409,
				"The selected provider and model are not configured. Configure credentials and prepare a new approval.",
			);
	}

	async #profile(projectId: string, dataset: Dataset): Promise<DatasetProfile> {
		const profile = await this.#store.getProfile(projectId, dataset.id);
		const current = await this.#store.getDataset(projectId, dataset.id);
		if (
			!profile ||
			current.currentVersionId !== dataset.currentVersionId ||
			profile.datasetVersionId !== current.currentVersionId
		)
			throw new WorkbenchError(409, "Compute a current dataset profile before preparing an assistant request.");
		return profile;
	}

	async #current(context: AssistantContext): Promise<DatasetProfile> {
		const dataset = await this.#store.getDataset(context.project.id, context.dataset.id);
		if (dataset.currentVersionId !== context.dataset.versionId) throw new WorkbenchError(409, STALE_CONTEXT);
		const profile = await this.#profile(context.project.id, dataset);
		if (profile.datasetVersionHash !== context.dataset.artifactHash) throw new WorkbenchError(409, STALE_CONTEXT);
		return profile;
	}

	#dropDraft(id: string): void {
		const staged = this.#drafts.get(id);
		if (staged) clearTimeout(staged.timer);
		this.#drafts.delete(id);
	}

	prepare(projectId: string, datasetId: string, value: unknown): Promise<AssistantDraft> {
		return this.#operation(async () => {
			const dataset = await this.#store.getDataset(projectId, datasetId);
			const selection = parseAssistantSelection(value, dataset);
			this.#assertOpen();
			for (const [id, staged] of this.#drafts)
				if (Date.parse(staged.draft.expiresAt) <= Date.now()) this.#dropDraft(id);
			if (this.#drafts.size + this.#preparing >= MAX_DRAFTS)
				throw new WorkbenchError(
					409,
					"Ten approvals are already staged. Send one or wait for an approval to expire.",
				);
			this.#preparing++;
			try {
				await this.#configured(selection.provider, selection.modelId);
				const profile = await this.#profile(projectId, dataset);
				const project = this.#store.getProject(projectId);
				const charts = await this.#store.listCharts(projectId, datasetId);
				const context = prepareAssistantContext(project, dataset, profile, charts, selection);
				const payload = buildAssistantPayload(context, selection.request);
				if (Buffer.byteLength(JSON.stringify(context), "utf8") > ASSISTANT_CONTEXT_BYTES)
					throw new WorkbenchError(
						400,
						"Selected metadata exceeds the assistant context limit. Select fewer columns or filters.",
					);
				this.#assertOpen();
				const now = Date.now();
				const draft: AssistantDraft = {
					id: randomUUID(),
					projectId,
					datasetId,
					provider: selection.provider,
					modelId: selection.modelId,
					createdAt: new Date(now).toISOString(),
					expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
					payloadHash: payloadHash(selection.provider, selection.modelId, payload),
					payload,
					context,
				};
				const timer = setTimeout(() => this.#dropDraft(draft.id), APPROVAL_TTL_MS);
				timer.unref();
				this.#drafts.set(draft.id, { draft, request: selection.request, profileHash: hash(profile), timer });
				return structuredClone(draft);
			} finally {
				this.#preparing--;
			}
		});
	}

	start(projectId: string, datasetId: string, value: unknown): Promise<AssistantRun> {
		return this.#operation(async () => {
			await this.#store.getDataset(projectId, datasetId);
			if (
				!objectWithKeys(value, ["draftId", "payloadHash"]) ||
				typeof value.draftId !== "string" ||
				typeof value.payloadHash !== "string"
			)
				throw new WorkbenchError(400, "Approve a staged draft using its identifier and exact payload hash.");
			const staged = this.#drafts.get(value.draftId);
			if (!staged || staged.draft.projectId !== projectId || staged.draft.datasetId !== datasetId)
				throw new WorkbenchError(404, "Approval was not found in this dataset. Prepare a new approval.");
			const { draft } = staged;
			if (Date.parse(draft.expiresAt) <= Date.now()) {
				this.#dropDraft(draft.id);
				throw new WorkbenchError(409, "Approval expired. Review and approve a new payload.");
			}
			if (
				draft.payloadHash !== value.payloadHash ||
				draft.payloadHash !== payloadHash(draft.provider, draft.modelId, draft.payload)
			)
				throw new WorkbenchError(409, "Approval does not match the staged payload. Review and approve it again.");
			this.#assertOpen();
			if (this.#active || this.#starting)
				throw new WorkbenchError(409, "An assistant request is active. Wait for it to finish or cancel it first.");
			this.#starting = true;
			try {
				await this.#configured(draft.provider, draft.modelId);
				const profile = await this.#current(draft.context);
				if (hash(profile) !== staged.profileHash) throw new WorkbenchError(409, STALE_CONTEXT);
				if (Date.parse(draft.expiresAt) <= Date.now() || this.#drafts.get(draft.id) !== staged)
					throw new WorkbenchError(409, "Approval expired. Review and approve a new payload.");
				this.#assertOpen();
				const now = new Date().toISOString();
				const run: AssistantRun = {
					id: randomUUID(),
					projectId,
					datasetId,
					datasetVersionId: draft.context.dataset.versionId,
					provider: draft.provider,
					modelId: draft.modelId,
					createdAt: now,
					updatedAt: now,
					state: "running",
					request: staged.request,
					context: structuredClone(draft.context),
					payloadHash: draft.payloadHash,
					summary: "",
					suggestions: [],
					usage: { ...EMPTY_USAGE },
					latencyMs: 0,
					receivedCharacters: 0,
					error: null,
				};
				await this.#store.putAssistantRun(run);
				this.#dropDraft(draft.id);
				const active: ActiveGeneration = {
					run,
					controller: new AbortController(),
					task: Promise.resolve(),
					startedAt: Date.now(),
					receivedCharacters: 0,
					usage: { ...EMPTY_USAGE },
					finished: false,
				};
				this.#active = active;
				if (this.#closing) this.#stop(active, "cancelled");
				active.task = this.#generate(active, draft.payload, staged.profileHash);
				void active.task.catch(() => {});
				return structuredClone(run);
			} finally {
				this.#starting = false;
			}
		});
	}

	#stop(active: ActiveGeneration, reason: NonNullable<ActiveGeneration["stop"]>): void {
		if (active.finished || active.stop) return;
		active.stop = reason;
		active.controller.abort();
	}

	#progress(active: ActiveGeneration, progress: AssistantProgress): void {
		if (active.finished || active.controller.signal.aborted) return;
		if (progress.type === "progress")
			active.receivedCharacters = Math.max(
				active.receivedCharacters,
				Math.min(ASSISTANT_OUTPUT_BYTES, count(progress.receivedCharacters)),
			);
		else if (progress.type === "usage") active.usage = mergeUsage(active.usage, progress.usage);
		if (active.progressTimer || active.progressWrite) return;
		active.progressTimer = setTimeout(() => {
			active.progressTimer = undefined;
			active.progressWrite = this.#serialized(active.run.id, async () => {
				if (active.finished) return;
				const run = await this.#store.assistantRun(active.run.projectId, active.run.datasetId, active.run.id);
				if (run.state !== "running" || active.finished) return;
				this.#metrics(run, active);
				await this.#store.putAssistantRun(run);
			})
				.catch(() => this.#stop(active, "storage"))
				.finally(() => {
					active.progressWrite = undefined;
				});
		}, PROGRESS_INTERVAL_MS);
		active.progressTimer.unref();
	}

	#metrics(run: AssistantRun, active: ActiveGeneration): void {
		run.receivedCharacters = Math.max(run.receivedCharacters, active.receivedCharacters);
		run.usage = mergeUsage(run.usage, active.usage);
		run.latencyMs = Math.max(run.latencyMs, Date.now() - active.startedAt);
		run.updatedAt = new Date().toISOString();
	}

	async #generate(active: ActiveGeneration, payload: AssistantPayload, profileHash: string): Promise<void> {
		let output: ReturnType<typeof parseAssistantOutput> | undefined;
		let failure: string | null = null;
		active.deadline = setTimeout(() => this.#stop(active, "timeout"), ASSISTANT_TIMEOUT_MS);
		active.deadline.unref();
		try {
			try {
				const profile = await this.#current(active.run.context);
				if (hash(profile) !== profileHash) throw new WorkbenchError(409, STALE_CONTEXT);
			} catch {
				failure = STALE_CONTEXT;
				return;
			}
			if (active.controller.signal.aborted) return;
			let result: Awaited<ReturnType<AssistantDriver["generate"]>>;
			try {
				result = await this.#driver.generate(
					{ provider: active.run.provider, modelId: active.run.modelId, payload: { ...payload } },
					(progress) => this.#progress(active, progress),
					active.controller.signal,
				);
			} catch {
				failure =
					"Assistant generation failed. Check provider credentials, model availability, and connectivity, then explicitly approve a new request.";
				return;
			}
			if (active.controller.signal.aborted) return;
			active.usage = mergeUsage(active.usage, result.usage);
			try {
				if (typeof result.text !== "string" || Buffer.byteLength(result.text, "utf8") > ASSISTANT_OUTPUT_BYTES)
					throw new Error("Invalid response size.");
				output = parseAssistantOutput(result.text, active.run.context);
			} catch {
				failure =
					"The model response did not match the required suggestion schema or limits. No suggestions were accepted. Review the request and explicitly approve a new attempt.";
			}
		} finally {
			active.finished = true;
			clearTimeout(active.deadline);
			clearTimeout(active.progressTimer);
			await active.progressWrite;
			try {
				await this.#serialized(active.run.id, async () => {
					const run = await this.#store.assistantRun(active.run.projectId, active.run.datasetId, active.run.id);
					this.#metrics(run, active);
					if (active.stop === "cancelled") {
						run.state = "cancelled";
						run.error = "Assistant request was cancelled. No suggestions were applied.";
					} else if (active.stop || failure || !output) {
						run.state = "failed";
						run.error =
							active.stop === "timeout"
								? "Assistant request exceeded the five-minute limit. Explicitly approve a new attempt."
								: active.stop === "storage"
									? "Assistant progress could not be saved. Check local storage before trying again."
									: failure;
					} else {
						run.state = "completed";
						run.summary = output.summary;
						run.suggestions = output.suggestions;
						run.error = null;
					}
					await this.#store.putAssistantRun(run);
				});
			} finally {
				if (this.#active === active) this.#active = undefined;
			}
		}
	}

	#view(run: AssistantRun, dataset: Dataset): AssistantRun {
		if (dataset.currentVersionId !== run.datasetVersionId)
			for (const suggestion of run.suggestions) suggestion.error = STALE_CONTEXT;
		return run;
	}

	list(projectId: string, datasetId: string): Promise<AssistantRun[]> {
		return this.#operation(async () => {
			const dataset = await this.#store.getDataset(projectId, datasetId);
			return (await this.#store.assistantRuns(projectId, datasetId)).map((run) => this.#view(run, dataset));
		});
	}

	get(projectId: string, datasetId: string, runId: string): Promise<AssistantRun> {
		return this.#operation(async () => {
			const dataset = await this.#store.getDataset(projectId, datasetId);
			return this.#view(await this.#store.assistantRun(projectId, datasetId, runId), dataset);
		});
	}

	cancel(projectId: string, datasetId: string, runId: string): Promise<AssistantRun> {
		return this.#operation(async () => {
			await this.#store.assistantRun(projectId, datasetId, runId);
			const active = this.#active;
			if (active?.run.id === runId && active.run.projectId === projectId && active.run.datasetId === datasetId) {
				this.#stop(active, "cancelled");
				await active.task;
			}
			for (const preview of this.#previews.values()) if (preview.runId === runId) preview.controller.abort();
			return this.#serialized(runId, async () => {
				const run = await this.#store.assistantRun(projectId, datasetId, runId);
				this.#dropRunPreviews(runId);
				return run;
			});
		});
	}

	#suggestion(run: AssistantRun, suggestionId: string): AssistantSuggestion {
		const suggestion = run.suggestions.find((item) => item.id === suggestionId);
		if (!suggestion) throw new WorkbenchError(404, "Suggestion was not found in this run.");
		if (run.state !== "completed")
			throw new WorkbenchError(409, "Only completed assistant runs have actionable suggestions.");
		return suggestion;
	}

	transition(
		projectId: string,
		datasetId: string,
		runId: string,
		suggestionId: string,
		value: unknown,
	): Promise<AssistantRun> {
		return this.#operation(() =>
			this.#serialized(runId, async () => {
				this.#assertOpen();
				const run = await this.#store.assistantRun(projectId, datasetId, runId);
				const suggestion = this.#suggestion(run, suggestionId);
				if (!objectWithKeys(value, ["status"]) || (value.status !== "accepted" && value.status !== "rejected"))
					throw new WorkbenchError(
						400,
						"Choose accepted or rejected; only an explicit chart application can mark a suggestion applied.",
					);
				if (suggestion.status === "applied" || suggestion.status === "reverted")
					throw new WorkbenchError(409, "Applied or reverted suggestions cannot be accepted or rejected again.");
				if (suggestion.status === value.status) return run;
				suggestion.status = value.status;
				suggestion.error = null;
				run.updatedAt = new Date().toISOString();
				this.#dropSuggestionPreview(runId, suggestionId);
				await this.#store.putAssistantRun(run);
				return run;
			}),
		);
	}

	#dropPreview(id: string): void {
		const preview = this.#previews.get(id);
		if (!preview) return;
		clearTimeout(preview.timer);
		preview.controller.abort();
		this.#previews.delete(id);
	}

	#dropSuggestionPreview(runId: string, suggestionId: string): void {
		for (const [id, preview] of this.#previews)
			if (preview.runId === runId && preview.suggestionId === suggestionId) this.#dropPreview(id);
	}

	#dropRunPreviews(runId: string): void {
		for (const [id, preview] of this.#previews) if (preview.runId === runId) this.#dropPreview(id);
	}

	#identity(run: AssistantRun, suggestion: AssistantSuggestion): string {
		return hash({
			projectId: run.projectId,
			datasetId: run.datasetId,
			runId: run.id,
			suggestionId: suggestion.id,
			payloadHash: run.payloadHash,
			artifactHash: run.context.dataset.artifactHash,
			action: suggestion.proposedAction,
		});
	}

	#acceptedChart(
		run: AssistantRun,
		suggestionId: string,
	): AssistantSuggestion & { proposedAction: Extract<AssistantSuggestion["proposedAction"], { kind: "chart" }> } {
		const suggestion = this.#suggestion(run, suggestionId);
		if (suggestion.proposedAction.kind !== "chart")
			throw new WorkbenchError(
				409,
				"This suggestion is read-only. Generated code and modeling proposals cannot be executed.",
			);
		if (suggestion.status !== "accepted")
			throw new WorkbenchError(409, "Accept this chart suggestion before previewing or applying it.");
		return suggestion as AssistantSuggestion & {
			proposedAction: Extract<AssistantSuggestion["proposedAction"], { kind: "chart" }>;
		};
	}

	preview(
		projectId: string,
		datasetId: string,
		runId: string,
		suggestionId: string,
		signal?: AbortSignal,
	): Promise<AssistantChartPreview> {
		return this.#operation(() =>
			this.#serialized(runId, async () => {
				this.#assertOpen();
				const run = await this.#store.assistantRun(projectId, datasetId, runId);
				const suggestion = this.#acceptedChart(run, suggestionId);
				this.#assertOpen();
				if (signal?.aborted) throw new WorkbenchError(409, "Chart preview was cancelled.");
				const identity = this.#identity(run, suggestion);
				for (const [id, cached] of this.#previews) {
					if (cached.expiresAt <= Date.now()) this.#dropPreview(id);
					else if (cached.identity === identity && cached.result) {
						await this.#current(run.context);
						this.#assertOpen();
						if (cached.controller.signal.aborted || signal?.aborted)
							throw new WorkbenchError(409, "Chart preview was cancelled.");
						return structuredClone(cached.result);
					}
				}
				this.#dropSuggestionPreview(runId, suggestionId);
				if (this.#previews.size >= MAX_PREVIEWS)
					throw new WorkbenchError(
						409,
						"Eight chart previews are active. Apply or reject one, or wait for it to expire.",
					);
				const cached: CachedPreview = {
					id: randomUUID(),
					runId,
					suggestionId,
					identity,
					controller: new AbortController(),
					expiresAt: Date.now() + APPROVAL_TTL_MS,
				};
				this.#previews.set(cached.id, cached);
				const abort = () => cached.controller.abort();
				signal?.addEventListener("abort", abort, { once: true });
				try {
					await this.#current(run.context);
					if (cached.controller.signal.aborted || this.#closing)
						throw new WorkbenchError(409, "Chart preview was cancelled.");
					const chart = await this.#store.chartPreview(
						projectId,
						datasetId,
						suggestion.proposedAction.spec,
						cached.controller.signal,
					);
					if (cached.controller.signal.aborted || this.#closing)
						throw new WorkbenchError(409, "Chart preview was cancelled.");
					if (
						chart.datasetVersionHash !== run.context.dataset.artifactHash ||
						hash(chart.spec) !== hash(suggestion.proposedAction.spec) ||
						Buffer.byteLength(JSON.stringify(chart), "utf8") > CHART_RESULT_BYTES
					)
						throw new WorkbenchError(409, "Chart preview did not match the approved suggestion.");
					await this.#current(run.context);
					if (cached.controller.signal.aborted || this.#closing)
						throw new WorkbenchError(409, "Chart preview was cancelled.");
					cached.result = { previewId: cached.id, chart };
					cached.expiresAt = Date.now() + APPROVAL_TTL_MS;
					cached.timer = setTimeout(() => this.#dropPreview(cached.id), APPROVAL_TTL_MS);
					cached.timer.unref();
					return structuredClone(cached.result);
				} catch (error) {
					const cancelled = cached.controller.signal.aborted || this.#closing;
					this.#dropPreview(cached.id);
					suggestion.status = "failed";
					suggestion.error = cancelled
						? "Chart preview was cancelled. Accept the suggestion to try again."
						: "Chart preview failed. Check the current profile, chart configuration, and analytical worker, then accept the suggestion to retry.";
					run.updatedAt = new Date().toISOString();
					await this.#store.putAssistantRun(run);
					throw new WorkbenchError(error instanceof WorkbenchError ? error.status : 500, suggestion.error);
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			}),
		);
	}

	apply(
		projectId: string,
		datasetId: string,
		runId: string,
		suggestionId: string,
		value: unknown,
	): Promise<AssistantRun> {
		return this.#operation(() =>
			this.#serialized(runId, async () => {
				this.#assertOpen();
				const run = await this.#store.assistantRun(projectId, datasetId, runId);
				const suggestion = this.#acceptedChart(run, suggestionId);
				if (!objectWithKeys(value, ["previewId"]) || typeof value.previewId !== "string")
					throw new WorkbenchError(400, "A matching chart preview identifier is required.");
				const cached = this.#previews.get(value.previewId);
				if (
					!cached?.result ||
					cached.expiresAt <= Date.now() ||
					cached.identity !== this.#identity(run, suggestion) ||
					cached.controller.signal.aborted
				)
					throw new WorkbenchError(
						409,
						"Preview this accepted suggestion again before applying it; its matching preview is missing or expired.",
					);
				await this.#current(run.context);
				this.#assertOpen();
				if (
					cached.controller.signal.aborted ||
					cached.expiresAt <= Date.now() ||
					this.#previews.get(cached.id) !== cached
				)
					throw new WorkbenchError(
						409,
						"Chart application was cancelled or its preview expired. Preview it again before applying.",
					);
				try {
					const applied = await this.#store.applyAssistantChart(run, suggestionId, suggestion.title);
					this.#dropPreview(cached.id);
					return applied;
				} catch (error) {
					this.#dropPreview(cached.id);
					suggestion.status = "failed";
					suggestion.error =
						"Chart could not be saved. Check the current dataset, saved-chart limit, and local storage. Accept and preview it again to retry.";
					run.updatedAt = new Date().toISOString();
					await this.#store.putAssistantRun(run);
					throw new WorkbenchError(error instanceof WorkbenchError ? error.status : 500, suggestion.error);
				}
			}),
		);
	}

	revert(projectId: string, datasetId: string, runId: string, suggestionId: string): Promise<AssistantRun> {
		return this.#operation(() =>
			this.#serialized(runId, async () => {
				this.#assertOpen();
				const run = await this.#store.assistantRun(projectId, datasetId, runId);
				const suggestion = this.#suggestion(run, suggestionId);
				if (suggestion.status !== "applied" || suggestion.proposedAction.kind !== "chart" || !suggestion.chartId)
					throw new WorkbenchError(409, "Only a saved chart owned by an applied suggestion can be reverted.");
				try {
					return await this.#store.revertAssistantChart(run, suggestionId);
				} catch (error) {
					throw new WorkbenchError(
						error instanceof WorkbenchError ? error.status : 500,
						"Saved chart could not be reverted. It may have been edited or removed; inspect it in Visualize before trying again.",
					);
				}
			}),
		);
	}

	close(): Promise<void> {
		this.#closing = true;
		this.#closeTask ??= this.#close();
		return this.#closeTask;
	}

	async #close(): Promise<void> {
		for (const id of this.#drafts.keys()) this.#dropDraft(id);
		if (this.#active) this.#stop(this.#active, "cancelled");
		for (const preview of this.#previews.values()) preview.controller.abort();
		await Promise.allSettled([...this.#operations]);
		if (this.#active) {
			this.#stop(this.#active, "cancelled");
			await this.#active.task.catch(() => {});
		}
		for (const id of this.#previews.keys()) this.#dropPreview(id);
	}
}
