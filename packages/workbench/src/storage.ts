import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AnalyticalRequest, AnalyticalResult } from "./analytical-contracts.ts";
import { runAnalytical } from "./analytical-process.ts";
import {
	ASSISTANT_MAX_SUGGESTIONS,
	type AssistantRun,
	type AssistantSuggestion,
	SUGGESTION_STATUSES,
} from "./assistant-contracts.ts";
import type { ChartRecord, ChartResult, ChartSpec } from "./chart-contracts.ts";
import { parseChartSpec } from "./chart-spec.ts";
import type {
	Dataset,
	DatasetFormat,
	DatasetVersion,
	DatasetVersionFacts,
	ImportJob,
	Preview,
	Project,
	ProjectSettings,
} from "./contracts.ts";
import {
	MAX_PREVIEW_ROWS,
	MAX_TEMP_BYTES,
	MAX_UPLOAD_BYTES,
	PAGE_SIZE,
	PROCESSING_TIMEOUT_MS,
	PROFILE_VERSION,
	SCHEMA_VERSION,
} from "./contracts.ts";
import type { Conversation } from "./conversation-contracts.ts";
import { MetadataStore, type TransformDraft } from "./metadata.ts";
import { type DatasetProfile, PROFILER_VERSION, type ProfileInput } from "./profile-contracts.ts";
import { isDatasetProfile } from "./profile-validation.ts";
import {
	TRANSFORM_DRAFT_TTL_MS,
	TRANSFORM_MAX_VERSIONS,
	TRANSFORM_RESULT_BYTES,
	type TransformHistory,
	type TransformPreview,
	type TransformRecord,
	type TransformSpec,
} from "./transform-contracts.ts";
import { parseTransformSpec } from "./transform-spec.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const RESERVATION_TIMEOUT_MS = 60_000;
const UPLOAD_IDLE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_TRANSFORM_DRAFTS = 4;
const MAX_TRANSFORM_RECORDS = 100;
const MAX_TRANSFORM_HISTORY_BYTES = 16 * 1024 * 1024;

export class WorkbenchError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "WorkbenchError";
		this.status = status;
	}
}

function validateConversationMessage(value: Conversation["messages"][number]): boolean {
	return (
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		(value.role === "user" || value.role === "assistant") &&
		(value.state === "complete" || value.state === "cancelled" || value.state === "failed") &&
		Number.isFinite(Date.parse(value.createdAt))
	);
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (reason: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => {});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface ActiveJob {
	job: ImportJob;
	stagingPath: string;
	dataset?: Dataset;
	source: Deferred<AsyncIterable<Uint8Array>>;
	uploaded: Deferred<ImportJob>;
	stopped: Deferred<never>;
	stopError?: WorkbenchError;
	nextRejected?: (error: WorkbenchError) => void;
	claimed: boolean;
	committing: boolean;
	controller: AbortController;
	idleTimer?: NodeJS.Timeout;
	deadlineTimer?: NodeJS.Timeout;
	task: Promise<void>;
}

interface ActiveTransform {
	controller: AbortController;
	done: Deferred<void>;
	committing: boolean;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function validateId(id: string): void {
	if (typeof id !== "string" || !ID.test(id)) throw new WorkbenchError(400, "Invalid resource identifier.");
}

async function writeJson(path: string, value: unknown): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify(value));
		await file.sync();
	} finally {
		await file.close();
	}
}

async function readJson<T>(path: string): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if (hasCode(error, "ENOENT")) throw new WorkbenchError(404, "Requested resource was not found.");
		throw new WorkbenchError(500, "Stored metadata could not be read.");
	}
}

export class WorkbenchStore {
	readonly #root: string;
	readonly #jobs = new Map<string, ImportJob>();
	#metadata?: MetadataStore;
	#previewTask?: Promise<Preview>;
	#previewController?: AbortController;
	#chartTask?: Promise<ChartResult>;
	#chartController?: AbortController;
	#profileRead?: {
		projectId: string;
		datasetId: string;
		task: Promise<DatasetProfile | null>;
		controller: AbortController;
	};
	#transformWork?: ActiveTransform;
	#transformExpiry?: NodeJS.Timeout;
	#transformCleanup?: Promise<void>;
	#active?: ActiveJob;
	#ready = false;
	#closing = false;
	#initializing?: Promise<void>;
	#closeTask?: Promise<void>;
	#lockToken?: string;

	constructor(root: string) {
		this.#root = resolve(root);
	}

	init(): Promise<void> {
		if (this.#closing) return Promise.reject(new WorkbenchError(503, "Workbench is closed."));
		this.#initializing ??= this.#initialize();
		return this.#initializing;
	}

	async #initialize(): Promise<void> {
		try {
			await mkdir(this.#root, { recursive: true, mode: 0o700 });
			await this.#acquireLock();
			await mkdir(join(this.#root, "projects"), { recursive: true });
			await rm(join(this.#root, "staging"), { recursive: true, force: true });
			await mkdir(join(this.#root, "staging"));
			this.#metadata = new MetadataStore(join(this.#root, "workbench.sqlite"));
			await this.#migrateLegacy();
			await this.#recoverArtifacts();
			this.#metadata.recoverJobs();
			this.#metadata.recoverAssistantRuns();
			await mkdir(join(this.#root, "transform-drafts"), { recursive: true });
			await this.#upgradeVersionFacts();
			this.#metadata.recoverTransforms();
			await this.#recoverTransformDrafts();
			this.#ready = true;
		} catch (error) {
			this.#metadata?.close();
			this.#metadata = undefined;
			await this.#releaseLock();
			if (error instanceof WorkbenchError) throw error;
			throw new WorkbenchError(500, "Workbench storage could not be initialized.");
		}
	}

	async #acquireLock(): Promise<void> {
		const token = randomUUID();
		const candidate = join(this.#root, `.owner-${token}`);
		const lock = join(this.#root, "owner.lock");
		await writeJson(candidate, { pid: process.pid, token });
		try {
			try {
				// Link a fully written record so another opener never sees partial JSON.
				await link(candidate, lock);
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
				const owner = await readJson<{ pid: number; token: string }>(lock);
				if (
					!Number.isSafeInteger(owner.pid) ||
					owner.pid <= 0 ||
					typeof owner.token !== "string" ||
					!ID.test(owner.token)
				) {
					throw new WorkbenchError(409, "Storage owner is unknown; the lock requires manual inspection.");
				}
				try {
					process.kill(owner.pid, 0);
					throw new WorkbenchError(409, "This storage directory is already open in another process.");
				} catch (error) {
					if (!hasCode(error, "ESRCH")) {
						if (error instanceof WorkbenchError) throw error;
						throw new WorkbenchError(409, "The storage owner could not be safely verified.");
					}
				}
				const claim = join(this.#root, `.reclaim-${owner.token}`);
				try {
					await link(candidate, claim);
				} catch {
					throw new WorkbenchError(
						409,
						"Storage lock recovery is already in progress; inspect the lock if this persists.",
					);
				}
				try {
					const current = await readJson<{ token: string }>(lock);
					if (current.token !== owner.token)
						throw new WorkbenchError(409, "Storage ownership changed; retry opening it.");
					await unlink(lock);
					try {
						await link(candidate, lock);
					} catch (error) {
						if (hasCode(error, "EEXIST"))
							throw new WorkbenchError(409, "This storage directory was opened by another process.");
						throw error;
					}
				} finally {
					await unlink(claim);
				}
			}
			this.#lockToken = token;
		} finally {
			await unlink(candidate);
		}
	}

	async #releaseLock(): Promise<void> {
		if (!this.#lockToken) return;
		const lock = join(this.#root, "owner.lock");
		const owner = await readJson<{ token: string }>(lock);
		if (owner.token === this.#lockToken) await unlink(lock);
		this.#lockToken = undefined;
	}

	#assertReady(): void {
		if (!this.#ready || this.#closing) throw new WorkbenchError(503, "Workbench storage is not available.");
	}

	async #migrateLegacy(): Promise<void> {
		const metadata = this.#metadata!;
		if (metadata.migrated) return;
		for (const entry of await readdir(join(this.#root, "projects"), { withFileTypes: true })) {
			if (!entry.isDirectory() || !ID.test(entry.name)) continue;
			const directory = join(this.#root, "projects", entry.name);
			let previous: { id: string; name: string; createdAt: string };
			try {
				previous = await readJson(join(directory, "project.json"));
			} catch (error) {
				if (error instanceof WorkbenchError && error.status === 404) continue;
				throw error;
			}
			if (previous.id !== entry.name || typeof previous.name !== "string" || typeof previous.createdAt !== "string")
				throw new WorkbenchError(500, "Legacy project metadata is invalid. Original files were retained.");
			if (!metadata.project(previous.id))
				metadata.putProject({
					...previous,
					ownerId: null,
					description: "",
					updatedAt: previous.createdAt,
					settings: { previewRowLimit: PAGE_SIZE },
				});
			await mkdir(join(directory, "datasets"), { recursive: true });
			for (const item of await readdir(join(directory, "datasets"), { withFileTypes: true })) {
				if (!item.isDirectory() || !ID.test(item.name) || metadata.dataset(previous.id, item.name)) continue;
				const datasetDirectory = join(directory, "datasets", item.name);
				const old = await readJson<{
					id: string;
					projectId: string;
					name: string;
					createdAt: string;
					byteSize: number;
					sha256: string;
				}>(join(datasetDirectory, "metadata.json"));
				if (
					old.id !== item.name ||
					old.projectId !== previous.id ||
					typeof old.name !== "string" ||
					typeof old.createdAt !== "string" ||
					!Number.isSafeInteger(old.byteSize) ||
					old.byteSize < 1 ||
					!/^[a-f0-9]{64}$/.test(old.sha256)
				)
					throw new WorkbenchError(500, "Legacy dataset metadata is invalid. Original files were retained.");
				const sourceId = randomUUID();
				const versionId = randomUUID();
				const staging = join(this.#root, "staging", randomUUID());
				const destination = join(datasetDirectory, "versions", versionId);
				let moved = false;
				try {
					await mkdir(staging);
					const result = await runAnalytical({
						kind: "ingest",
						sourcePath: join(datasetDirectory, "source.csv"),
						artifactPath: join(staging, "data.duckdb"),
						tempPath: join(staging, "temp"),
						format: "csv",
						expectedSha256: old.sha256,
						expectedByteSize: old.byteSize,
					});
					if (result.kind !== "ingest" || result.sha256 !== old.sha256 || result.byteSize !== old.byteSize)
						throw new Error("Integrity mismatch.");
					await rm(join(staging, "temp"), { recursive: true, force: true });
					await mkdir(join(datasetDirectory, "versions"), { recursive: true });
					await rename(staging, destination);
					moved = true;
					const dataset = this.#datasetRecord(
						previous.id,
						old.name,
						"csv",
						result,
						old.id,
						sourceId,
						versionId,
						old.createdAt,
					);
					const input = await this.#profileInput(dataset, new AbortController().signal);
					dataset.versions.find((version) => version.id === versionId)!.facts!.artifactSha256 =
						input.datasetVersionHash;
					metadata.putDataset(dataset);
				} catch {
					if (moved) await rm(destination, { recursive: true, force: true });
					throw new WorkbenchError(
						500,
						"An existing dataset could not be migrated within the ingestion limits or failed its integrity check. Original files and legacy metadata were retained; inspect storage before retrying.",
					);
				} finally {
					await rm(staging, { recursive: true, force: true });
				}
			}
		}
		metadata.finishMigration();
	}

	async #recoverArtifacts(): Promise<void> {
		for (const project of this.#metadata!.projects()) {
			const directory = join(this.#root, "projects", project.id, "datasets");
			await mkdir(directory, { recursive: true });
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (!entry.isDirectory() || !ID.test(entry.name)) continue;
				const dataset = this.#metadata!.dataset(project.id, entry.name);
				if (!dataset) {
					await rm(join(directory, entry.name), { recursive: true, force: true });
					continue;
				}
				const versions = join(directory, entry.name, "versions");
				await mkdir(versions, { recursive: true });
				const retained = new Set(
					dataset.versions.filter((version) => version.kind === "derived").map((version) => version.id),
				);
				for (const version of await readdir(versions, { withFileTypes: true })) {
					if (version.isDirectory() && ID.test(version.name) && !retained.has(version.name))
						await rm(join(versions, version.name), { recursive: true, force: true });
				}
			}
		}
	}

	async #upgradeVersionFacts(): Promise<void> {
		for (const project of this.#metadata!.projects()) {
			for (const dataset of this.#metadata!.datasets(project.id)) {
				let changed = false;
				for (const version of dataset.versions) {
					if (version.kind !== "derived" || version.facts?.artifactSha256) continue;
					if (version.operation.kind !== "ingest")
						throw new WorkbenchError(500, "Transformed version facts are missing.");
					// Before transformations, every historical ingestion used the same verified original.
					const snapshot = { ...dataset, currentVersionId: version.id };
					const input = await this.#profileInput(snapshot, new AbortController().signal);
					version.facts = {
						rowCount: dataset.rowCount,
						schema: dataset.schema,
						columns: dataset.columns,
						profileVersion: dataset.profileVersion,
						profiledAt: version.id === dataset.currentVersionId ? dataset.profiledAt : version.createdAt,
						artifactSha256: input.datasetVersionHash,
					};
					changed = true;
				}
				if (changed) this.#metadata!.putDataset(dataset);
			}
		}
	}

	#draftDirectory(id: string): string {
		validateId(id);
		return join(this.#root, "transform-drafts", id);
	}

	async #removeDraft(
		record: TransformRecord,
		state: "failed" | "cancelled" | "expired",
		message: string,
	): Promise<void> {
		record.state = state;
		record.completedAt = new Date().toISOString();
		record.error = message;
		this.#metadata!.transaction(() => {
			this.#metadata!.deleteTransformDraft(record.projectId, record.datasetId, record.id);
			this.#metadata!.putTransform(record);
		});
		await rm(this.#draftDirectory(record.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}

	async #recoverTransformDrafts(): Promise<void> {
		const retained = new Set<string>();
		for (const draft of this.#metadata!.transformDrafts()) {
			const record = this.#metadata!.transform(draft.projectId, draft.datasetId, draft.id)!;
			const dataset = this.#metadata!.dataset(draft.projectId, draft.datasetId);
			const timeline = this.#metadata!.transformTimeline(draft.projectId, draft.datasetId);
			if (Date.parse(draft.expiresAt) <= Date.now()) {
				await this.#removeDraft(record, "expired", "Preview expired. Generate a new preview before approving.");
				continue;
			}
			if (
				!dataset ||
				!record.result ||
				dataset.currentVersionId !== record.inputVersionId ||
				timeline.revision !== draft.revision
			) {
				await this.#removeDraft(record, "failed", "Dataset changed before this preview was approved.");
				continue;
			}
			try {
				const input = await this.#profileInput(dataset, new AbortController().signal);
				const output = await this.#profileInput(
					dataset,
					new AbortController().signal,
					join(this.#draftDirectory(draft.id), "data.duckdb"),
				);
				if (
					input.datasetVersionHash !== draft.inputHash ||
					output.datasetVersionHash !== draft.outputHash ||
					output.storageBytes !== draft.storageBytes
				)
					throw new Error("Integrity mismatch.");
				retained.add(draft.id);
			} catch {
				await this.#removeDraft(record, "failed", "Preview artifacts failed their integrity check after restart.");
			}
		}
		for (const entry of await readdir(join(this.#root, "transform-drafts"), { withFileTypes: true })) {
			if (!retained.has(entry.name))
				await rm(join(this.#root, "transform-drafts", entry.name), { recursive: true, force: true });
		}
		this.#scheduleTransformExpiry();
	}

	#scheduleTransformExpiry(): void {
		clearTimeout(this.#transformExpiry);
		if (this.#closing || !this.#metadata) return;
		const drafts = this.#metadata.transformDrafts();
		if (!drafts.length) return;
		const next = Math.min(...drafts.map((draft) => Date.parse(draft.expiresAt)));
		this.#transformExpiry = setTimeout(
			() => {
				if (this.#transformWork) {
					this.#scheduleTransformExpiry();
					return;
				}
				void this.#expireTransformDrafts().catch(() => {
					this.#scheduleTransformExpiry();
				});
			},
			Math.max(1000, next - Date.now()),
		);
		this.#transformExpiry.unref();
	}

	#expireTransformDrafts(): Promise<void> {
		if (this.#transformCleanup) return this.#transformCleanup;
		const task = (async () => {
			for (const draft of this.#metadata!.transformDrafts()) {
				if (Date.parse(draft.expiresAt) > Date.now()) continue;
				const record = this.#metadata!.transform(draft.projectId, draft.datasetId, draft.id)!;
				await this.#removeDraft(record, "expired", "Preview expired. Generate a new preview before approving.");
			}
		})();
		this.#transformCleanup = task;
		void task
			.finally(() => {
				this.#transformCleanup = undefined;
				this.#scheduleTransformExpiry();
			})
			.catch(() => {});
		return task;
	}

	#beginTransform(): ActiveTransform {
		this.#assertReady();
		if (this.#active || this.#previewTask || this.#profileRead || this.#chartTask || this.#transformWork)
			throw new WorkbenchError(409, "Another analytical operation is active.");
		const work = { controller: new AbortController(), done: deferred<void>(), committing: false };
		this.#transformWork = work;
		return work;
	}

	#checkTransform(signal: AbortSignal): void {
		if (signal.aborted)
			throw signal.reason instanceof WorkbenchError
				? signal.reason
				: new WorkbenchError(409, "Transformation was cancelled.");
		this.#assertReady();
	}

	async previewTransform(
		projectId: string,
		datasetId: string,
		value: unknown,
		signal?: AbortSignal,
	): Promise<TransformPreview> {
		const dataset = this.#dataset(projectId, datasetId);
		if (
			typeof value === "object" &&
			value !== null &&
			"datasetVersionId" in value &&
			value.datasetVersionId !== dataset.currentVersionId
		)
			throw new WorkbenchError(409, "Dataset version changed. Generate a new preview.");
		let spec: TransformSpec;
		try {
			spec = parseTransformSpec(value, dataset.schema, dataset.currentVersionId);
		} catch {
			throw new WorkbenchError(400, "Transformation specification is invalid for this dataset.");
		}
		if (dataset.versions.length >= TRANSFORM_MAX_VERSIONS)
			throw new WorkbenchError(409, "This dataset has reached the retained version limit.");
		const work = this.#beginTransform();
		const abort = () => work.controller.abort(new WorkbenchError(409, "Transformation preview was cancelled."));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const timer = setTimeout(
			() => work.controller.abort(new WorkbenchError(408, "Transformation preview exceeded the five-minute limit.")),
			PROCESSING_TIMEOUT_MS,
		);
		timer.unref();
		let record: TransformRecord | undefined;
		let directory: string | undefined;
		let retained = false;
		try {
			await this.#expireTransformDrafts();
			if (this.#metadata!.transformDrafts().length >= MAX_TRANSFORM_DRAFTS)
				throw new WorkbenchError(
					409,
					"Four transformation previews are retained. Discard or approve one before previewing another.",
				);
			const usage = this.#metadata!.transformUsage(projectId, datasetId);
			if (
				usage.count >= MAX_TRANSFORM_RECORDS ||
				usage.bytes + TRANSFORM_RESULT_BYTES + 64 * 1024 > MAX_TRANSFORM_HISTORY_BYTES
			)
				throw new WorkbenchError(409, "This dataset has reached its transformation audit storage limit.");
			const createdAt = new Date().toISOString();
			record = {
				id: randomUUID(),
				projectId,
				datasetId,
				actor: "local-user",
				createdAt,
				completedAt: null,
				inputVersionId: dataset.currentVersionId,
				outputVersionId: null,
				spec,
				state: "previewed",
				result: null,
				error: null,
			};
			this.#metadata!.putTransform(record);
			this.#checkTransform(work.controller.signal);
			const revision = this.#metadata!.transformTimeline(projectId, datasetId).revision;
			const input = await this.#profileInput(dataset, work.controller.signal);
			const facts = dataset.versions.find((version) => version.id === dataset.currentVersionId)!.facts!;
			if (input.datasetVersionHash !== facts.artifactSha256)
				throw new WorkbenchError(409, "Input version failed its immutable artifact integrity check.");
			directory = this.#draftDirectory(record.id);
			await mkdir(directory);
			this.#checkTransform(work.controller.signal);
			const result = await runAnalytical(
				{
					kind: "transform",
					artifactPath: this.#profileArtifact(dataset),
					tempPath: join(directory, "temp"),
					outputPath: join(directory, "data.duckdb"),
					input,
					spec,
				},
				undefined,
				work.controller.signal,
			).catch((error: Error) => {
				throw new WorkbenchError(400, error.message);
			});
			this.#checkTransform(work.controller.signal);
			if (
				result.kind !== "transform" ||
				result.impact.inputVersionId !== input.datasetVersionId ||
				result.impact.inputHash !== input.datasetVersionHash ||
				!isDeepStrictEqual(result.impact.spec, spec)
			)
				throw new WorkbenchError(500, "Unexpected transformation worker response.");
			const current = await this.#profileInput(dataset, work.controller.signal);
			const output = await this.#profileInput(dataset, work.controller.signal, join(directory, "data.duckdb"));
			await rm(join(directory, "temp"), { recursive: true, force: true });
			this.#checkTransform(work.controller.signal);
			if (
				current.datasetVersionHash !== input.datasetVersionHash ||
				this.#metadata!.dataset(projectId, datasetId)?.currentVersionId !== input.datasetVersionId ||
				this.#metadata!.transformTimeline(projectId, datasetId).revision !== revision
			)
				throw new WorkbenchError(409, "Dataset changed while preparing the preview.");
			record.result = result.impact;
			record.completedAt = new Date().toISOString();
			const draft: TransformDraft = {
				id: record.id,
				projectId,
				datasetId,
				outputVersionId: randomUUID(),
				inputHash: input.datasetVersionHash,
				outputHash: output.datasetVersionHash,
				storageBytes: output.storageBytes,
				createdAt,
				expiresAt: new Date(Date.now() + TRANSFORM_DRAFT_TTL_MS).toISOString(),
				revision,
			};
			const saved = record;
			this.#metadata!.transaction(() => {
				this.#metadata!.putTransform(saved);
				this.#metadata!.putTransformDraft(draft);
			});
			retained = true;
			return { id: draft.id, projectId, datasetId, createdAt, expiresAt: draft.expiresAt, impact: result.impact };
		} catch (error) {
			const failure = work.controller.signal.aborted
				? work.controller.signal.reason instanceof WorkbenchError
					? work.controller.signal.reason
					: new WorkbenchError(409, "Transformation was cancelled.")
				: error instanceof WorkbenchError
					? error
					: new WorkbenchError(500, "Transformation preview failed. Check disk access and available space.");
			if (record) {
				record.state = work.controller.signal.aborted && failure.status !== 408 ? "cancelled" : "failed";
				record.completedAt = new Date().toISOString();
				record.error = failure.message;
				this.#metadata!.putTransform(record);
			}
			throw failure;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			try {
				if (directory && !retained)
					await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			} finally {
				this.#transformWork = undefined;
				work.done.resolve();
				this.#scheduleTransformExpiry();
			}
		}
	}

	async applyTransform(projectId: string, datasetId: string, value: unknown): Promise<Dataset> {
		const dataset = this.#dataset(projectId, datasetId);
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Reflect.ownKeys(value).length !== 2 ||
			!Object.hasOwn(value, "previewId") ||
			!Object.hasOwn(value, "approved") ||
			!("previewId" in value) ||
			typeof value.previewId !== "string" ||
			!("approved" in value) ||
			value.approved !== true
		)
			throw new WorkbenchError(400, "Explicit approval and a preview identifier are required.");
		validateId(value.previewId);
		const record = this.#metadata!.transform(projectId, datasetId, value.previewId);
		if (!record) throw new WorkbenchError(404, "Preview was not found in this dataset.");
		const work = this.#beginTransform();
		let published: string | undefined;
		let committed = false;
		let claimed = false;
		try {
			await this.#expireTransformDrafts();
			const draft = this.#metadata!.transformDraft(projectId, datasetId, record.id);
			if (!draft || record.state !== "previewed" || !record.result)
				throw new WorkbenchError(409, "This preview is no longer available for approval.");
			claimed = true;
			const timeline = this.#metadata!.transformTimeline(projectId, datasetId);
			if (
				dataset.currentVersionId !== record.inputVersionId ||
				timeline.revision !== draft.revision ||
				dataset.versions.length >= TRANSFORM_MAX_VERSIONS
			)
				throw new WorkbenchError(409, "Dataset changed. Generate and approve a new preview.");
			const input = await this.#profileInput(dataset, work.controller.signal);
			const directory = this.#draftDirectory(draft.id);
			const output = await this.#profileInput(dataset, work.controller.signal, join(directory, "data.duckdb"));
			this.#checkTransform(work.controller.signal);
			if (
				input.datasetVersionHash !== draft.inputHash ||
				output.datasetVersionHash !== draft.outputHash ||
				output.storageBytes !== draft.storageBytes
			)
				throw new WorkbenchError(409, "Preview or input artifact changed. Nothing was applied.");
			if (Date.parse(draft.expiresAt) <= Date.now())
				throw new WorkbenchError(409, "Preview expired before approval completed.");
			const now = new Date().toISOString();
			const facts: DatasetVersionFacts = {
				rowCount: record.result.rowCount,
				schema: record.result.schema,
				columns: record.result.columns,
				profileVersion: PROFILE_VERSION,
				profiledAt: now,
				artifactSha256: draft.outputHash,
			};
			const destination = join(this.#datasetPath(projectId, datasetId), "versions", draft.outputVersionId);
			const version: DatasetVersion = {
				id: draft.outputVersionId,
				kind: "derived",
				parentVersionId: record.inputVersionId,
				storageLocation: relative(this.#root, join(destination, "data.duckdb")),
				createdAt: now,
				facts,
				operation: {
					kind: "transform",
					engine: "duckdb",
					version: record.result.engineVersion,
					spec: record.spec,
					recordId: record.id,
				},
			};
			const updated = this.#versionDataset({ ...dataset, versions: [...dataset.versions, version] }, version);
			work.committing = true;
			await rename(directory, destination);
			published = destination;
			record.state = "applied";
			record.completedAt = now;
			record.outputVersionId = version.id;
			this.#metadata!.transaction(() => {
				if (
					this.#metadata!.dataset(projectId, datasetId)?.currentVersionId !== record.inputVersionId ||
					this.#metadata!.transformTimeline(projectId, datasetId).revision !== draft.revision
				)
					throw new WorkbenchError(409, "Dataset changed before publication.");
				this.#metadata!.putDataset(updated);
				this.#metadata!.putTransformTimeline(projectId, datasetId, {
					undo: [...timeline.undo, dataset.currentVersionId],
					redo: [],
					revision: timeline.revision + 1,
				});
				this.#metadata!.deleteTransformDraft(projectId, datasetId, record.id);
				this.#metadata!.putTransform(record);
			});
			committed = true;
			return updated;
		} catch (error) {
			const failure =
				error instanceof WorkbenchError
					? error
					: new WorkbenchError(500, "Transformation publication failed. The active dataset was not changed.");
			if (claimed) {
				record.outputVersionId = null;
				await this.#removeDraft(record, work.controller.signal.aborted ? "cancelled" : "failed", failure.message);
			}
			throw failure;
		} finally {
			try {
				if (published && !committed)
					await rm(published, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			} finally {
				this.#transformWork = undefined;
				work.done.resolve();
				this.#scheduleTransformExpiry();
			}
		}
	}

	#versionDataset(dataset: Dataset, version: DatasetVersion): Dataset {
		if (!version.facts || version.kind !== "derived")
			throw new WorkbenchError(500, "Dataset version facts are unavailable.");
		return {
			...dataset,
			currentVersionId: version.id,
			updatedAt: new Date().toISOString(),
			rowCount: version.facts.rowCount,
			columnCount: version.facts.schema.length,
			schema: version.facts.schema,
			columns: version.facts.columns,
			profileVersion: version.facts.profileVersion,
			profiledAt: version.facts.profiledAt,
		};
	}

	async transformHistory(projectId: string, datasetId: string): Promise<TransformHistory> {
		this.#dataset(projectId, datasetId);
		if (!this.#transformWork) await this.#expireTransformDrafts();
		const dataset = this.#dataset(projectId, datasetId);
		const timeline = this.#metadata!.transformTimeline(projectId, datasetId);
		return {
			currentVersionId: dataset.currentVersionId,
			canUndo: timeline.undo.length > 0,
			canRedo: timeline.redo.length > 0,
			records: this.#metadata!.transforms(projectId, datasetId),
		};
	}

	async discardTransform(projectId: string, datasetId: string, previewId: string): Promise<{ discarded: true }> {
		this.#dataset(projectId, datasetId);
		validateId(previewId);
		const record = this.#metadata!.transform(projectId, datasetId, previewId);
		if (!record) throw new WorkbenchError(404, "Preview was not found in this dataset.");
		const work = this.#beginTransform();
		try {
			await this.#expireTransformDrafts();
			if (!this.#metadata!.transformDraft(projectId, datasetId, previewId))
				throw new WorkbenchError(409, "This preview is no longer available.");
			await this.#removeDraft(record, "cancelled", "The user discarded this preview without applying it.");
			return { discarded: true };
		} finally {
			this.#transformWork = undefined;
			work.done.resolve();
			this.#scheduleTransformExpiry();
		}
	}

	async undoTransform(projectId: string, datasetId: string, value: unknown): Promise<Dataset> {
		return this.#moveTransform(projectId, datasetId, value, "undo");
	}
	async redoTransform(projectId: string, datasetId: string, value: unknown): Promise<Dataset> {
		return this.#moveTransform(projectId, datasetId, value, "redo");
	}
	async #moveTransform(
		projectId: string,
		datasetId: string,
		value: unknown,
		direction: "undo" | "redo",
	): Promise<Dataset> {
		const dataset = this.#dataset(projectId, datasetId);
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Reflect.ownKeys(value).length !== 1 ||
			!Object.hasOwn(value, "expectedVersionId") ||
			!("expectedVersionId" in value) ||
			typeof value.expectedVersionId !== "string"
		)
			throw new WorkbenchError(400, "Expected dataset version is required.");
		validateId(value.expectedVersionId);
		if (value.expectedVersionId !== dataset.currentVersionId)
			throw new WorkbenchError(409, "Dataset version changed. Refresh before changing history.");
		const work = this.#beginTransform();
		try {
			const timeline = this.#metadata!.transformTimeline(projectId, datasetId);
			const targetId = timeline[direction].at(-1);
			if (!targetId) throw new WorkbenchError(409, `There is no transformation to ${direction}.`);
			const version = dataset.versions.find((item) => item.id === targetId);
			if (!version) throw new WorkbenchError(500, "History refers to a missing dataset version.");
			const updated = this.#versionDataset(dataset, version);
			const input = await this.#profileInput(updated, work.controller.signal);
			this.#checkTransform(work.controller.signal);
			if (input.datasetVersionHash !== version.facts!.artifactSha256)
				throw new WorkbenchError(409, "Historical version failed its immutable artifact integrity check.");
			timeline[direction].pop();
			timeline[direction === "undo" ? "redo" : "undo"].push(dataset.currentVersionId);
			timeline.revision++;
			work.committing = true;
			this.#metadata!.transaction(() => {
				this.#metadata!.putDataset(updated);
				this.#metadata!.putTransformTimeline(projectId, datasetId, timeline);
			});
			return updated;
		} finally {
			this.#transformWork = undefined;
			work.done.resolve();
		}
	}

	#project(projectId: string): Project {
		validateId(projectId);
		const project = this.#metadata?.project(projectId);
		if (!project) throw new WorkbenchError(404, "Requested project was not found.");
		return project;
	}

	getProject(projectId: string): Project {
		this.#assertReady();
		return this.#project(projectId);
	}

	async listProjects(): Promise<Project[]> {
		this.#assertReady();
		return this.#metadata!.projects();
	}

	async createProject(
		name: string,
		description = "",
		settings: ProjectSettings = { previewRowLimit: PAGE_SIZE },
	): Promise<Project> {
		this.#assertReady();
		if (
			typeof name !== "string" ||
			!name.trim() ||
			name.trim().length > 120 ||
			/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)
		) {
			throw new WorkbenchError(400, "Project name must contain 1 to 120 characters without control characters.");
		}
		if (
			typeof description !== "string" ||
			description.length > 2000 ||
			/[\u0000\u202a-\u202e\u2066-\u2069]/.test(description)
		)
			throw new WorkbenchError(400, "Project description must be at most 2000 characters without unsafe controls.");
		if (!settings || ![25, 100, 500].includes(settings.previewRowLimit))
			throw new WorkbenchError(400, "Default preview must be 25, 100 or 500 rows.");
		const now = new Date().toISOString();
		const project: Project = {
			id: randomUUID(),
			ownerId: null,
			name: name.trim(),
			description,
			createdAt: now,
			updatedAt: now,
			settings: { previewRowLimit: settings.previewRowLimit },
		};
		this.#metadata!.putProject(project);
		return project;
	}

	async listDatasets(projectId: string): Promise<Dataset[]> {
		this.#assertReady();
		this.#project(projectId);
		return this.#metadata!.datasets(projectId);
	}

	#datasetPath(projectId: string, datasetId: string): string {
		validateId(projectId);
		validateId(datasetId);
		return join(this.#root, "projects", projectId, "datasets", datasetId);
	}

	#dataset(projectId: string, datasetId: string): Dataset {
		this.#assertReady();
		this.#project(projectId);
		validateId(datasetId);
		const dataset = this.#metadata!.dataset(projectId, datasetId);
		if (!dataset) throw new WorkbenchError(404, "Requested dataset was not found in this project.");
		return dataset;
	}

	async getDataset(projectId: string, datasetId: string): Promise<Dataset> {
		return this.#dataset(projectId, datasetId);
	}

	async assistantRuns(projectId: string, datasetId: string): Promise<AssistantRun[]> {
		await this.getDataset(projectId, datasetId);
		this.#assertReady();
		return this.#metadata!.assistantRuns(projectId, datasetId);
	}

	async assistantRun(projectId: string, datasetId: string, id: string): Promise<AssistantRun> {
		await this.getDataset(projectId, datasetId);
		this.#assertReady();
		validateId(id);
		const run = this.#metadata!.assistantRun(projectId, datasetId, id);
		if (!run) throw new WorkbenchError(404, "Assistant run was not found in this dataset or has expired.");
		return run;
	}
	async conversations(projectId: string, datasetId: string): Promise<Conversation[]> {
		await this.getDataset(projectId, datasetId);
		this.#assertReady();
		return this.#metadata!.conversations(projectId, datasetId);
	}

	async conversation(projectId: string, datasetId: string, id: string): Promise<Conversation> {
		await this.getDataset(projectId, datasetId);
		this.#assertReady();
		validateId(id);
		const conversation = this.#metadata!.conversation(projectId, datasetId, id);
		if (!conversation) throw new WorkbenchError(404, "Conversation was not found in this dataset.");
		return conversation;
	}

	async putConversation(conversation: Conversation): Promise<void> {
		await this.getDataset(conversation.projectId, conversation.datasetId);
		this.#assertReady();
		validateId(conversation.id);
		if (
			conversation.scope.projectId !== conversation.projectId ||
			conversation.scope.datasetId !== conversation.datasetId ||
			conversation.scope.datasetVersionId !== conversation.scope.context.dataset.versionId ||
			typeof conversation.title !== "string" ||
			!conversation.title.trim() ||
			conversation.title.length > 120 ||
			(conversation.archivedAt !== null && !Number.isFinite(Date.parse(conversation.archivedAt))) ||
			!["ready", "running", "failed"].includes(conversation.state) ||
			!Array.isArray(conversation.messages) ||
			conversation.messages.some(
				(message) => !validateConversationMessage(message) || message.text.length > 16 * 1024,
			)
		)
			throw new WorkbenchError(400, "Conversation state is invalid.");
		this.#metadata!.transaction(() => this.#metadata!.putConversation(conversation));
	}

	async conversationSessionDir(projectId: string, datasetId: string): Promise<string> {
		await this.getDataset(projectId, datasetId);
		const directory = join(this.#datasetPath(projectId, datasetId), "assistant-sessions");
		await mkdir(directory, { recursive: true });
		return directory;
	}

	#assistantSuggestion(run: AssistantRun, id: string): AssistantSuggestion {
		if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$(?![\s\S])/u.test(id))
			throw new WorkbenchError(400, "Invalid suggestion identifier.");
		const suggestion = run.suggestions.find((item) => item.id === id);
		if (!suggestion) throw new WorkbenchError(404, "Suggestion was not found in this assistant run.");
		return suggestion;
	}

	#assistantChartName(title: string): string {
		return this.#chartName(
			title
				.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
				.trim()
				.slice(0, 120)
				.trim() || "Assistant chart",
		);
	}

	#assistantCurrent(run: AssistantRun): Dataset {
		const dataset = this.#metadata!.dataset(run.projectId, run.datasetId);
		if (!dataset) throw new WorkbenchError(404, "Requested dataset was not found in this project.");
		if (dataset.currentVersionId !== run.datasetVersionId)
			throw new WorkbenchError(409, "Dataset version changed. Review and approve a new assistant request.");
		return dataset;
	}

	#validateAssistantRun(run: AssistantRun, previous: AssistantRun | undefined): void {
		validateId(run.id);
		validateId(run.datasetVersionId);
		if (
			!["running", "completed", "cancelled", "failed"].includes(run.state) ||
			run.context.project.id !== run.projectId ||
			run.context.dataset.id !== run.datasetId ||
			run.context.dataset.versionId !== run.datasetVersionId ||
			!Array.isArray(run.suggestions) ||
			run.suggestions.length > ASSISTANT_MAX_SUGGESTIONS ||
			(run.state !== "completed" && run.suggestions.length !== 0) ||
			!Number.isFinite(Date.parse(run.createdAt)) ||
			!Number.isFinite(Date.parse(run.updatedAt)) ||
			Date.parse(run.updatedAt) < Date.parse(run.createdAt) ||
			!Number.isFinite(run.latencyMs) ||
			run.latencyMs < 0 ||
			!Number.isSafeInteger(run.receivedCharacters) ||
			run.receivedCharacters < 0 ||
			(run.state === "failed" && (typeof run.error !== "string" || !run.error))
		)
			throw new WorkbenchError(400, "Assistant run state is invalid.");
		const ids = new Set<string>();
		for (const suggestion of run.suggestions) {
			this.#assistantSuggestion(run, suggestion.id);
			if (ids.has(suggestion.id) || !SUGGESTION_STATUSES.includes(suggestion.status))
				throw new WorkbenchError(400, "Assistant suggestion state is invalid.");
			ids.add(suggestion.id);
			if (suggestion.chartId !== null) validateId(suggestion.chartId);
			if (
				(suggestion.status === "applied" || suggestion.status === "reverted") !== (suggestion.chartId !== null) ||
				(suggestion.chartId !== null && suggestion.proposedAction.kind !== "chart")
			)
				throw new WorkbenchError(400, "Assistant chart ownership is invalid.");
		}
		if (!previous) {
			if (run.state !== "running")
				throw new WorkbenchError(409, "New assistant runs must begin in the running state.");
			this.#assistantCurrent(run);
			return;
		}
		if (
			previous.datasetVersionId !== run.datasetVersionId ||
			previous.createdAt !== run.createdAt ||
			previous.provider !== run.provider ||
			previous.modelId !== run.modelId ||
			previous.request !== run.request ||
			previous.payloadHash !== run.payloadHash ||
			!isDeepStrictEqual(previous.context, run.context) ||
			(previous.state !== "running" && previous.state !== run.state)
		)
			throw new WorkbenchError(409, "Assistant run identity or completed state cannot be changed.");
		if (previous.state === "running") {
			if (run.suggestions.some((suggestion) => suggestion.status !== "proposed" || suggestion.chartId !== null))
				throw new WorkbenchError(409, "New suggestions must be proposed without saved charts.");
			return;
		}
		if (previous.summary !== run.summary || previous.suggestions.length !== run.suggestions.length)
			throw new WorkbenchError(409, "Completed assistant output cannot be replaced.");
		for (let index = 0; index < run.suggestions.length; index++) {
			const current = run.suggestions[index];
			const old = previous.suggestions[index];
			const { status: _oldStatus, error: _oldError, ...oldContent } = old;
			const { status: _newStatus, error: _newError, ...newContent } = current;
			if (
				!isDeepStrictEqual(oldContent, newContent) ||
				(current.status !== old.status &&
					(current.status === "proposed" ||
						[old.status, current.status].some((status) => status === "applied" || status === "reverted") ||
						(current.status === "failed" &&
							(old.status !== "accepted" || current.proposedAction.kind !== "chart"))))
			)
				throw new WorkbenchError(
					409,
					"Suggestion content and chart ownership require the original assistant output.",
				);
		}
	}

	async putAssistantRun(run: AssistantRun): Promise<void> {
		await this.getDataset(run.projectId, run.datasetId);
		this.#assertReady();
		this.#metadata!.transaction(() => {
			const previous = this.#metadata!.assistantRun(run.projectId, run.datasetId, run.id);
			this.#validateAssistantRun(run, previous);
			if (!previous) {
				this.#metadata!.pruneAssistantRuns(run.projectId, run.datasetId);
				if (this.#metadata!.assistantRunCount(run.projectId, run.datasetId) >= 100)
					throw new WorkbenchError(
						409,
						"This dataset already has 100 active assistant runs. Wait for a run to finish.",
					);
			}
			this.#metadata!.putAssistantRun(run);
		});
	}

	async applyAssistantChart(run: AssistantRun, suggestionId: string, name: string): Promise<AssistantRun> {
		await this.getDataset(run.projectId, run.datasetId);
		this.#assertReady();
		validateId(run.id);
		let updated!: AssistantRun;
		this.#metadata!.transaction(() => {
			const previous = this.#metadata!.assistantRun(run.projectId, run.datasetId, run.id);
			if (!previous) throw new WorkbenchError(404, "Assistant run was not found in this dataset or has expired.");
			if (!isDeepStrictEqual(previous, run))
				throw new WorkbenchError(409, "Assistant run changed. Refresh before applying.");
			const suggestion = this.#assistantSuggestion(previous, suggestionId);
			if (
				previous.state !== "completed" ||
				suggestion.status !== "accepted" ||
				suggestion.chartId !== null ||
				suggestion.proposedAction.kind !== "chart"
			)
				throw new WorkbenchError(409, "Only accepted chart suggestions can be applied.");
			const dataset = this.#assistantCurrent(previous);
			const now = new Date().toISOString();
			const chart: ChartRecord = {
				id: randomUUID(),
				projectId: run.projectId,
				datasetId: run.datasetId,
				name: this.#assistantChartName(name),
				createdAt: now,
				updatedAt: now,
				spec: this.#chartSpec(dataset, suggestion.proposedAction.spec, true),
			};
			if (chart.name !== this.#assistantChartName(suggestion.title))
				throw new WorkbenchError(400, "Assistant chart name must match its suggestion title.");
			if (this.#metadata!.chartCount(run.projectId, run.datasetId) >= 100)
				throw new WorkbenchError(
					409,
					"This dataset already has 100 saved charts. Delete a chart before saving another.",
				);
			suggestion.status = "applied";
			suggestion.chartId = chart.id;
			suggestion.error = null;
			previous.updatedAt = now;
			this.#metadata!.putChart(chart);
			this.#metadata!.putAssistantRun(previous);
			updated = previous;
		});
		return updated;
	}

	async revertAssistantChart(run: AssistantRun, suggestionId: string): Promise<AssistantRun> {
		await this.getDataset(run.projectId, run.datasetId);
		this.#assertReady();
		validateId(run.id);
		let updated!: AssistantRun;
		this.#metadata!.transaction(() => {
			const previous = this.#metadata!.assistantRun(run.projectId, run.datasetId, run.id);
			if (!previous) throw new WorkbenchError(404, "Assistant run was not found in this dataset or has expired.");
			if (!isDeepStrictEqual(previous, run))
				throw new WorkbenchError(409, "Assistant run changed. Refresh before reverting.");
			const suggestion = this.#assistantSuggestion(previous, suggestionId);
			if (
				previous.state !== "completed" ||
				suggestion.status !== "applied" ||
				!suggestion.chartId ||
				suggestion.proposedAction.kind !== "chart"
			)
				throw new WorkbenchError(409, "Only applied chart suggestions can be reverted.");
			validateId(suggestion.chartId);
			const chart = this.#metadata!.chart(run.projectId, run.datasetId, suggestion.chartId);
			if (
				!chart ||
				!isDeepStrictEqual(chart.spec, suggestion.proposedAction.spec) ||
				chart.name !== this.#assistantChartName(suggestion.title)
			)
				throw new WorkbenchError(
					409,
					"The assistant chart was edited or removed. Intentional chart edits cannot be reverted here.",
				);
			suggestion.status = "reverted";
			suggestion.error = null;
			previous.updatedAt = new Date().toISOString();
			this.#metadata!.deleteChart(run.projectId, run.datasetId, chart.id);
			this.#metadata!.putAssistantRun(previous);
			updated = previous;
		});
		return updated;
	}

	async listCharts(projectId: string, datasetId: string): Promise<ChartRecord[]> {
		await this.getDataset(projectId, datasetId);
		this.#assertReady();
		return this.#metadata!.charts(projectId, datasetId);
	}

	#chartName(value: unknown): string {
		if (
			typeof value !== "string" ||
			!value.trim() ||
			value.trim().length > 120 ||
			/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
		)
			throw new WorkbenchError(400, "Chart name must contain 1 to 120 characters without control characters.");
		return value.trim();
	}

	#chartSpec(dataset: Dataset, value: unknown, currentOnly: boolean): ChartSpec {
		if (typeof value !== "object" || value === null || !("datasetVersionId" in value))
			throw new WorkbenchError(400, "A structured chart specification is required.");
		const versionId = value.datasetVersionId;
		if (
			typeof versionId !== "string" ||
			!dataset.versions.some((version) => version.id === versionId && version.kind === "derived" && version.facts) ||
			(currentOnly && versionId !== dataset.currentVersionId)
		)
			throw new WorkbenchError(
				409,
				"Chart belongs to a different dataset version. Select the current version before previewing.",
			);
		try {
			return parseChartSpec(
				value,
				dataset.versions.find((version) => version.id === versionId)!.facts!.schema,
				versionId,
			);
		} catch {
			throw new WorkbenchError(400, "Chart specification is invalid for this dataset.");
		}
	}

	async createChart(projectId: string, datasetId: string, name: unknown, value: unknown): Promise<ChartRecord> {
		const dataset = await this.getDataset(projectId, datasetId);
		this.#assertReady();
		const now = new Date().toISOString();
		const chart: ChartRecord = {
			id: randomUUID(),
			projectId,
			datasetId,
			name: this.#chartName(name),
			createdAt: now,
			updatedAt: now,
			spec: this.#chartSpec(dataset, value, false),
		};
		this.#metadata!.transaction(() => {
			if (this.#metadata!.chartCount(projectId, datasetId) >= 100)
				throw new WorkbenchError(
					409,
					"This dataset already has 100 saved charts. Delete a chart before saving another.",
				);
			this.#metadata!.putChart(chart);
		});
		return chart;
	}

	async updateChart(
		projectId: string,
		datasetId: string,
		id: string,
		name: unknown,
		value: unknown,
	): Promise<ChartRecord> {
		const dataset = await this.getDataset(projectId, datasetId);
		this.#assertReady();
		validateId(id);
		const previous = this.#metadata!.chart(projectId, datasetId, id);
		if (!previous) throw new WorkbenchError(404, "Requested chart was not found in this dataset.");
		const chart: ChartRecord = {
			...previous,
			name: this.#chartName(name),
			spec: this.#chartSpec(dataset, value, false),
			updatedAt: new Date().toISOString(),
		};
		this.#metadata!.putChart(chart);
		return chart;
	}

	async deleteChart(projectId: string, datasetId: string, id: string): Promise<{ deleted: true }> {
		await this.getDataset(projectId, datasetId);
		this.#assertReady();
		validateId(id);
		if (!this.#metadata!.chart(projectId, datasetId, id))
			throw new WorkbenchError(404, "Requested chart was not found in this dataset.");
		this.#metadata!.deleteChart(projectId, datasetId, id);
		return { deleted: true };
	}

	async chartPreview(
		projectId: string,
		datasetId: string,
		value: unknown,
		signal?: AbortSignal,
	): Promise<ChartResult> {
		const dataset = await this.getDataset(projectId, datasetId);
		this.#assertReady();
		const spec = this.#chartSpec(dataset, value, true);
		if (this.#active || this.#previewTask || this.#profileRead || this.#chartTask || this.#transformWork)
			throw new WorkbenchError(409, "Another analytical operation is active.");
		const controller = new AbortController();
		const abort = () => controller.abort(new WorkbenchError(409, "Chart preview was cancelled."));
		const check = () => {
			if (controller.signal.aborted)
				throw controller.signal.reason instanceof WorkbenchError
					? controller.signal.reason
					: new WorkbenchError(409, "Chart preview was cancelled.");
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const timer = setTimeout(
			() => controller.abort(new WorkbenchError(408, "Chart preview exceeded the five-minute limit.")),
			PROCESSING_TIMEOUT_MS,
		);
		timer.unref();
		const directory = join(this.#root, "staging", randomUUID());
		this.#chartController = controller;
		const task = (async (): Promise<ChartResult> => {
			try {
				check();
				const input = await this.#profileInput(dataset, controller.signal);
				check();
				if (!this.#cachedProfile(dataset, input))
					throw new WorkbenchError(409, "Compute a current dataset profile before previewing charts.");
				await mkdir(directory);
				check();
				const result = await runAnalytical(
					{
						kind: "chart",
						artifactPath: this.#profileArtifact(dataset),
						tempPath: directory,
						input,
						spec,
					},
					undefined,
					controller.signal,
				).catch((error: Error) => {
					throw new WorkbenchError(400, error.message);
				});
				check();
				if (result.kind !== "chart") throw new WorkbenchError(500, "Unexpected chart worker response.");
				const current = await this.#profileInput(dataset, controller.signal);
				check();
				if (
					current.datasetVersionHash !== input.datasetVersionHash ||
					current.storageBytes !== input.storageBytes ||
					this.#metadata!.dataset(projectId, datasetId)?.currentVersionId !== input.datasetVersionId
				)
					throw new WorkbenchError(409, "Dataset changed while preparing the chart; no chart was returned.");
				return result.chart;
			} catch (error) {
				check();
				throw error instanceof WorkbenchError
					? error
					: new WorkbenchError(500, "Chart preview failed. Check disk access and available space.");
			} finally {
				await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {
					throw new WorkbenchError(500, "Chart temporary files could not be removed. Check disk permissions.");
				});
			}
		})();
		this.#chartTask = task;
		try {
			const result = await task;
			check();
			return result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.#chartTask = undefined;
			this.#chartController = undefined;
		}
	}

	async preview(projectId: string, datasetId: string, offset: number, limit = PAGE_SIZE): Promise<Preview> {
		this.#assertReady();
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new WorkbenchError(400, "Preview offset must be a nonnegative integer.");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PREVIEW_ROWS)
			throw new WorkbenchError(400, "Preview limit must be between 1 and 500 rows.");
		const dataset = await this.getDataset(projectId, datasetId);
		this.#assertReady();
		if (this.#active || this.#previewTask || this.#profileRead || this.#chartTask || this.#transformWork)
			throw new WorkbenchError(409, "An analytical operation is active. Retry the preview when it finishes.");
		if (offset >= dataset.rowCount) return { offset, limit, total: dataset.rowCount, rows: [] };
		const version = dataset.versions.find((item) => item.id === dataset.currentVersionId && item.kind === "derived");
		if (!version) throw new WorkbenchError(500, "Dataset has no analytical version.");
		const directory = join(this.#root, "staging", randomUUID());
		const controller = new AbortController();
		this.#previewController = controller;
		const task = (async (): Promise<Preview> => {
			try {
				await mkdir(directory);
				const result = await runAnalytical(
					{
						kind: "preview",
						artifactPath: this.#storedPath(version.storageLocation),
						tempPath: directory,
						offset,
						limit,
						total: dataset.rowCount,
					},
					undefined,
					controller.signal,
				).catch((error: Error) => {
					throw new WorkbenchError(400, error.message);
				});
				if (result.kind !== "preview") throw new Error("Unexpected analytical response.");
				return result.preview;
			} catch (error) {
				throw error instanceof WorkbenchError
					? error
					: new WorkbenchError(500, "Preview could not be read. Check available disk space and permissions.");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		})();
		this.#previewTask = task;
		try {
			return await task;
		} finally {
			this.#previewTask = undefined;
			this.#previewController = undefined;
		}
	}

	async createImport(projectId: string, name: string, mimeType?: string): Promise<ImportJob> {
		this.#assertReady();
		const format = this.#format(name, mimeType);
		this.#project(projectId);
		const active = this.#reserve(projectId, name, "import", undefined, format);
		active.task = this.#run(active);
		return { ...active.job };
	}

	async retryImport(projectId: string, jobId: string): Promise<ImportJob> {
		this.#assertReady();
		const previous = this.getJob(projectId, jobId);
		if (previous.kind === "profile")
			throw new WorkbenchError(409, "Start the dataset profile again instead of retrying an import.");
		if (previous.kind !== "import" || !["failed", "cancelled"].includes(previous.state))
			throw new WorkbenchError(409, "Only failed or cancelled imports can be retried.");
		const active = this.#reserve(projectId, previous.name, "import", undefined, previous.format);
		active.job.retryOf = previous.id;
		this.#saveJob(active.job);
		active.task = this.#run(active);
		return { ...active.job };
	}

	#format(name: string, mimeType?: string): DatasetFormat {
		if (
			typeof name !== "string" ||
			!name.trim() ||
			name.length > 255 ||
			/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
		)
			throw new WorkbenchError(400, "Filename must be a simple name without paths or unsafe controls.");
		const format = /\.csv$/i.test(name) ? "csv" : /\.parquet$/i.test(name) ? "parquet" : undefined;
		if (!format) throw new WorkbenchError(415, "Choose a .csv or .parquet file.");
		const mime = mimeType?.split(";")[0].trim().toLowerCase() ?? "";
		const allowed =
			format === "csv"
				? ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"]
				: ["application/vnd.apache.parquet", "application/x-parquet", "application/parquet"];
		if (mime && mime !== "application/octet-stream" && !allowed.includes(mime))
			throw new WorkbenchError(415, "The MIME hint does not match the filename format.");
		return format;
	}

	#reserve(
		projectId: string,
		name: string,
		kind: ImportJob["kind"],
		dataset?: Dataset,
		format: DatasetFormat = dataset?.format ?? "csv",
	): ActiveJob {
		this.#assertReady();
		if (this.#active || this.#previewTask || this.#profileRead || this.#chartTask || this.#transformWork)
			throw new WorkbenchError(409, "Another analytical operation is active.");
		const job: ImportJob = {
			id: randomUUID(),
			projectId,
			name,
			kind,
			format,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			state: kind === "import" ? "uploading" : "processing",
			bytesReceived: kind === "profile" ? 0 : (dataset?.byteSize ?? 0),
			bytesProcessed: 0,
			rowCount: 0,
		};
		if (dataset) job.datasetId = dataset.id;
		const active: ActiveJob = {
			job,
			dataset,
			controller: new AbortController(),
			stagingPath: join(this.#root, "staging", job.id),
			source: deferred(),
			uploaded: deferred(),
			stopped: deferred(),
			claimed: false,
			committing: false,
			task: Promise.resolve(),
		};
		this.#active = active;
		this.#saveJob(job);
		this.#metadata!.pruneJobs();
		if (kind === "import") this.#idleDeadline(active, RESERVATION_TIMEOUT_MS);
		return active;
	}

	#saveJob(job: ImportJob): void {
		job.updatedAt = new Date().toISOString();
		this.#jobs.set(job.id, { ...job });
		this.#metadata?.putJob(job);
	}

	getJob(projectId: string, jobId: string): ImportJob {
		validateId(projectId);
		validateId(jobId);
		const cached = this.#jobs.get(jobId);
		const job = cached?.projectId === projectId ? cached : this.#metadata?.job(projectId, jobId);
		if (!job) throw new WorkbenchError(404, "Job was not found in this project or has expired.");
		return { ...job };
	}

	async upload(
		projectId: string,
		jobId: string,
		source: AsyncIterable<Uint8Array>,
		mimeType?: string,
	): Promise<ImportJob> {
		this.#assertReady();
		const job = this.getJob(projectId, jobId);
		this.#format(job.name, mimeType);
		const active = this.#active;
		if (!active || active.job.id !== jobId || active.job.state !== "uploading" || active.claimed)
			throw new WorkbenchError(409, "This job cannot accept an upload.");
		active.claimed = true;
		this.#idleDeadline(active, UPLOAD_IDLE_TIMEOUT_MS);
		active.deadlineTimer = setTimeout(
			() => this.#stop(active, new WorkbenchError(408, "Upload exceeded its time limit.")),
			UPLOAD_TIMEOUT_MS,
		);
		active.deadlineTimer.unref();
		active.source.resolve(source);
		return active.uploaded.promise;
	}

	#idleDeadline(active: ActiveJob, milliseconds: number): void {
		clearTimeout(active.idleTimer);
		active.idleTimer = setTimeout(
			() => this.#stop(active, new WorkbenchError(408, "Upload expired due to inactivity.")),
			milliseconds,
		);
		active.idleTimer.unref();
	}

	#stop(active: ActiveJob, error: WorkbenchError, cancelled = false): void {
		if (active.stopError || active.committing || active.job.state === "completed") return;
		active.stopError = error;
		if (cancelled) active.job.state = "cancelled";
		active.stopped.reject(error);
		active.controller.abort();
		active.nextRejected?.(error);
		clearTimeout(active.idleTimer);
		clearTimeout(active.deadlineTimer);
	}

	async cancel(projectId: string, jobId: string): Promise<ImportJob> {
		this.getJob(projectId, jobId);
		const active = this.#active;
		if (active?.job.id === jobId) {
			this.#stop(active, new WorkbenchError(409, "Operation was cancelled."), true);
			await active.task;
		}
		return this.getJob(projectId, jobId);
	}

	async reprofile(projectId: string, datasetId: string): Promise<ImportJob> {
		const dataset = await this.getDataset(projectId, datasetId);
		if (dataset.versions.find((version) => version.id === dataset.currentVersionId)?.operation.kind === "transform")
			return this.profile(projectId, datasetId);
		if (dataset.versions.length >= TRANSFORM_MAX_VERSIONS)
			throw new WorkbenchError(409, "This dataset has reached the retained version limit.");
		const active = this.#reserve(projectId, dataset.name, "reprofile", dataset);
		active.task = this.#run(active);
		return { ...active.job };
	}

	async getProfile(projectId: string, datasetId: string): Promise<DatasetProfile | null> {
		const dataset = await this.getDataset(projectId, datasetId);
		this.#assertReady();
		if (this.#profileRead) {
			if (this.#profileRead.projectId === projectId && this.#profileRead.datasetId === datasetId)
				return this.#profileRead.task;
			throw new WorkbenchError(409, "Another profile read is active.");
		}
		if (this.#chartTask || this.#transformWork)
			throw new WorkbenchError(409, "A chart preview is active. Retry the profile read when it finishes.");
		const controller = new AbortController();
		const task = (async () => {
			const input = await this.#profileInput(dataset, controller.signal);
			this.#assertReady();
			if (this.#metadata!.dataset(projectId, datasetId)?.currentVersionId !== input.datasetVersionId) return null;
			return this.#cachedProfile(dataset, input);
		})();
		this.#profileRead = { projectId, datasetId, task, controller };
		try {
			return await task;
		} finally {
			this.#profileRead = undefined;
		}
	}

	async profile(projectId: string, datasetId: string): Promise<ImportJob> {
		const dataset = await this.getDataset(projectId, datasetId);
		const active = this.#reserve(projectId, dataset.name, "profile", dataset);
		active.deadlineTimer = setTimeout(
			() => this.#stop(active, new WorkbenchError(408, "Dataset profiling exceeded its time limit.")),
			PROCESSING_TIMEOUT_MS,
		);
		active.deadlineTimer.unref();
		active.task = this.#run(active);
		return active.uploaded.promise;
	}

	#profileArtifact(dataset: Dataset): string {
		const version = dataset.versions.find((item) => item.id === dataset.currentVersionId && item.kind === "derived");
		if (!version) throw new WorkbenchError(500, "Dataset has no analytical version.");
		return this.#storedPath(version.storageLocation);
	}

	async #profileInput(dataset: Dataset, signal: AbortSignal, artifactPath?: string): Promise<ProfileInput> {
		const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
		try {
			const path = artifactPath ?? this.#profileArtifact(dataset);
			const pathBefore = await lstat(path);
			if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
				throw new WorkbenchError(409, "Profile artifact must be a regular file, not a symbolic link.");
			const file = await open(path, "r");
			try {
				const before = await file.stat();
				const unchanged = (snapshot: Stats): boolean =>
					snapshot.isFile() &&
					!snapshot.isSymbolicLink() &&
					snapshot.dev === before.dev &&
					snapshot.ino === before.ino &&
					snapshot.size === before.size &&
					snapshot.mtimeMs === before.mtimeMs &&
					snapshot.ctimeMs === before.ctimeMs;
				if (!unchanged(pathBefore))
					throw new WorkbenchError(409, "Analytical artifact changed while profiling; no profile was published.");
				if (!before.isFile() || before.size < 1 || before.size > MAX_TEMP_BYTES)
					throw new WorkbenchError(400, "Profile artifact exceeds the supported storage limits.");
				const buffer = Buffer.allocUnsafe(64 * 1024);
				const hash = createHash("sha256");
				let bytes = 0;
				while (bytes < before.size) {
					if (signal.aborted) throw new WorkbenchError(409, "Profile read was cancelled.");
					if (Date.now() > deadline) throw new WorkbenchError(408, "Dataset profiling exceeded its time limit.");
					const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - bytes), bytes);
					if (bytesRead === 0) break;
					hash.update(buffer.subarray(0, bytesRead));
					bytes += bytesRead;
				}
				const after = await file.stat();
				const pathAfter = await lstat(path);
				if (signal.aborted) throw new WorkbenchError(409, "Profile read was cancelled.");
				if (bytes !== before.size || !unchanged(after) || !unchanged(pathAfter))
					throw new WorkbenchError(409, "Analytical artifact changed while profiling; no profile was published.");
				return {
					datasetVersionId: dataset.currentVersionId,
					datasetVersionHash: hash.digest("hex"),
					rowCount: dataset.rowCount,
					sourceBytes: dataset.byteSize,
					storageBytes: bytes,
					schema: dataset.schema,
				};
			} finally {
				await file.close();
			}
		} catch (error) {
			throw error instanceof WorkbenchError
				? error
				: new WorkbenchError(500, "Profile artifact could not be read. Check disk access and available space.");
		}
	}

	#cachedProfile(dataset: Dataset, input: ProfileInput): DatasetProfile | null {
		const profile = this.#metadata!.profile(
			dataset.projectId,
			dataset.id,
			input.datasetVersionId,
			input.datasetVersionHash,
			PROFILER_VERSION,
		);
		return isDatasetProfile(profile, input) ? profile : null;
	}

	async #runProfile(active: ActiveJob): Promise<void> {
		const dataset = active.dataset!;
		const input = await this.#profileInput(dataset, active.controller.signal);
		let profile = this.#cachedProfile(dataset, input);
		if (!profile) {
			if (active.stopError) throw active.stopError;
			active.uploaded.resolve({ ...active.job });
			let savedProgressAt = 0;
			const result = await runAnalytical(
				{
					kind: "profile",
					artifactPath: this.#profileArtifact(dataset),
					tempPath: join(active.stagingPath, "temp"),
					input,
				},
				(progress) => {
					active.job.bytesProcessed = 0;
					active.job.rowCount = progress.rowCount;
					this.#jobs.set(active.job.id, { ...active.job });
					if (Date.now() - savedProgressAt >= 500) {
						this.#saveJob(active.job);
						savedProgressAt = Date.now();
					}
				},
				active.controller.signal,
			).catch((error: Error) => {
				throw new WorkbenchError(400, error.message);
			});
			if (result.kind !== "profile") throw new WorkbenchError(500, "Unexpected profile worker response.");
			profile = result.profile;
			const current = await this.#profileInput(dataset, active.controller.signal);
			if (current.datasetVersionHash !== input.datasetVersionHash || current.storageBytes !== input.storageBytes)
				throw new WorkbenchError(409, "Analytical artifact changed while profiling; no profile was published.");
		}
		await rm(active.stagingPath, { recursive: true, force: true });
		if (active.stopError) throw active.stopError;
		if (this.#metadata!.dataset(dataset.projectId, dataset.id)?.currentVersionId !== input.datasetVersionId)
			throw new WorkbenchError(409, "Dataset version changed while profiling; no profile was published.");
		active.committing = true;
		active.job.bytesProcessed = 0;
		active.job.rowCount = profile.sampling.sampleSize;
		active.job.state = "completed";
		active.job.updatedAt = new Date().toISOString();
		const completedProfile = profile;
		this.#metadata!.transaction(() => {
			this.#metadata!.putProfile(dataset.projectId, dataset.id, completedProfile);
			this.#metadata!.putJob(active.job);
		});
	}

	async #receive(active: ActiveJob, source: AsyncIterable<Uint8Array>): Promise<{ byteSize: number; sha256: string }> {
		const file = await open(join(active.stagingPath, `source.${active.job.format}`), "wx", 0o600);
		const hash = createHash("sha256");
		let iterator: AsyncIterator<Uint8Array> | undefined;
		let exhausted = false;
		try {
			iterator = source[Symbol.asyncIterator]();
			while (true) {
				if (active.stopError) throw active.stopError;
				const pending = iterator.next();
				const item = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
					active.nextRejected = reject;
					void pending.then(resolve, reject);
				});
				active.nextRejected = undefined;
				if (item.done) {
					exhausted = true;
					break;
				}
				if (!(item.value instanceof Uint8Array)) throw new WorkbenchError(400, "Upload must contain bytes.");
				if (item.value.byteLength > MAX_UPLOAD_BYTES - active.job.bytesReceived) {
					throw new WorkbenchError(413, "Dataset exceeds the 100 MB upload limit.");
				}
				if (item.value.byteLength === 0) continue;
				await file.writeFile(item.value);
				hash.update(item.value);
				active.job.bytesReceived += item.value.byteLength;
				this.#jobs.set(active.job.id, { ...active.job });
				this.#idleDeadline(active, UPLOAD_IDLE_TIMEOUT_MS);
			}
			if (active.stopError) throw active.stopError;
			if (active.job.bytesReceived === 0)
				throw new WorkbenchError(400, "Dataset is empty; a header or valid Parquet schema is required.");
			await file.sync();
			return { byteSize: active.job.bytesReceived, sha256: hash.digest("hex") };
		} finally {
			if (!exhausted && iterator?.return) {
				// Async-generator return() may itself wait for the stalled next().
				try {
					void Promise.resolve(iterator.return()).catch(() => {});
				} catch {
					// The job already records why this source was abandoned.
				}
			}
			await file.close();
		}
	}

	#storedPath(location: string): string {
		const target = resolve(this.#root, location);
		const local = relative(this.#root, target);
		if (isAbsolute(location) || local === ".." || local.startsWith(`..${sep}`))
			throw new WorkbenchError(500, "Stored artifact path is invalid.");
		return target;
	}

	#datasetRecord(
		projectId: string,
		name: string,
		format: DatasetFormat,
		result: Extract<AnalyticalResult, { kind: "ingest" }>,
		id: string,
		sourceId: string,
		versionId: string,
		createdAt: string,
		original?: Dataset,
	): Dataset {
		const now = new Date().toISOString();
		const directory = this.#datasetPath(projectId, id);
		const storageLocation = original?.storageLocation ?? relative(this.#root, join(directory, `source.${format}`));
		const sourceVersion = original?.versions.find((version) => version.id === original.sourceVersionId) ?? {
			id: sourceId,
			kind: "source" as const,
			parentVersionId: null,
			storageLocation,
			createdAt,
			operation: { kind: "upload" as const, engine: "workbench", version: "2" },
		};
		const derived = {
			id: versionId,
			kind: "derived" as const,
			parentVersionId: sourceId,
			storageLocation: relative(this.#root, join(directory, "versions", versionId, "data.duckdb")),
			createdAt: now,
			operation: { kind: "ingest" as const, engine: "duckdb", version: result.engineVersion },
			facts: {
				rowCount: result.rowCount,
				schema: result.schema,
				columns: result.columns,
				profileVersion: PROFILE_VERSION,
				profiledAt: now,
				artifactSha256: "",
			},
		};
		const duplicate = this.#metadata!.duplicate(projectId, result.sha256, format);
		return {
			id,
			projectId,
			name,
			originalFilename: original?.originalFilename ?? name,
			format,
			createdAt,
			updatedAt: now,
			byteSize: result.byteSize,
			sha256: result.sha256,
			rowCount: result.rowCount,
			columnCount: result.schema.length,
			ingestionStatus: "ready",
			schemaVersion: SCHEMA_VERSION,
			storageLocation,
			sourceVersionId: sourceId,
			currentVersionId: versionId,
			versions: [...(original?.versions ?? [sourceVersion]), derived],
			schema: result.schema,
			...(duplicate && duplicate !== id
				? { duplicateOf: duplicate }
				: original?.duplicateOf
					? { duplicateOf: original.duplicateOf }
					: {}),
			columns: result.columns,
			parsing:
				format === "csv"
					? { format, encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" }
					: { format, emptyValues: "null", valueEncoding: "duckdb-text" },
			profileVersion: PROFILE_VERSION,
			profiledAt: now,
		};
	}

	async #run(active: ActiveJob): Promise<void> {
		let failure: WorkbenchError | undefined;
		let published: string | undefined;
		let completed = false;
		try {
			await mkdir(active.stagingPath);
			if (active.job.kind === "profile") {
				await this.#runProfile(active);
				completed = true;
				return;
			}
			let expected: { byteSize: number; sha256: string };
			let sourcePath: string;
			if (active.dataset) {
				expected = active.dataset;
				sourcePath = this.#storedPath(active.dataset.storageLocation);
			} else {
				expected = await this.#receive(active, await Promise.race([active.source.promise, active.stopped.promise]));
				sourcePath = join(active.stagingPath, `source.${active.job.format}`);
			}
			if (active.stopError) throw active.stopError;
			clearTimeout(active.idleTimer);
			clearTimeout(active.deadlineTimer);
			active.job.state = "processing";
			this.#saveJob(active.job);
			active.uploaded.resolve({ ...active.job });
			const id = active.dataset?.id ?? randomUUID();
			const sourceId = active.dataset?.sourceVersionId ?? randomUUID();
			const versionId = randomUUID();
			const versionDirectory = join(active.stagingPath, "versions", versionId);
			await mkdir(versionDirectory, { recursive: true });
			const request: AnalyticalRequest = {
				kind: "ingest",
				sourcePath,
				artifactPath: join(versionDirectory, "data.duckdb"),
				tempPath: join(active.stagingPath, "temp"),
				format: active.job.format,
				expectedSha256: expected.sha256,
				expectedByteSize: expected.byteSize,
			};
			let savedProgressAt = 0;
			const result = await runAnalytical(
				request,
				(progress) => {
					active.job.bytesProcessed = progress.bytesProcessed;
					active.job.rowCount = progress.rowCount;
					this.#jobs.set(active.job.id, { ...active.job });
					if (Date.now() - savedProgressAt >= 500) {
						this.#saveJob(active.job);
						savedProgressAt = Date.now();
					}
				},
				active.controller.signal,
			).catch((error: Error) => {
				throw new WorkbenchError(400, error.message);
			});
			if (active.stopError) throw active.stopError;
			if (result.kind !== "ingest" || result.sha256 !== expected.sha256 || result.byteSize !== expected.byteSize)
				throw new WorkbenchError(409, "Preserved source integrity check failed; the dataset was not changed.");
			if (
				active.dataset &&
				(result.rowCount !== active.dataset.rowCount || result.schema.length !== active.dataset.columnCount)
			)
				throw new WorkbenchError(409, "Preserved source no longer matches the stored dataset.");
			const dataset = this.#datasetRecord(
				active.job.projectId,
				active.job.name,
				active.job.format,
				result,
				id,
				sourceId,
				versionId,
				active.dataset?.createdAt ?? new Date().toISOString(),
				active.dataset,
			);
			const artifactInput = await this.#profileInput(
				dataset,
				active.controller.signal,
				join(versionDirectory, "data.duckdb"),
			);
			dataset.versions.find((version) => version.id === versionId)!.facts!.artifactSha256 =
				artifactInput.datasetVersionHash;
			await rm(join(active.stagingPath, "temp"), { recursive: true, force: true });
			if (active.stopError) throw active.stopError;
			active.committing = true;
			const destination = this.#datasetPath(dataset.projectId, id);
			if (active.dataset) {
				await mkdir(join(destination, "versions"), { recursive: true });
				published = join(destination, "versions", versionId);
				await rename(versionDirectory, published);
			} else {
				await mkdir(join(this.#root, "projects", dataset.projectId, "datasets"), { recursive: true });
				published = destination;
				await rename(active.stagingPath, destination);
			}
			active.job.datasetId = id;
			active.job.bytesProcessed = result.byteSize;
			active.job.rowCount = result.rowCount;
			active.job.state = "completed";
			this.#metadata!.transaction(() => {
				this.#metadata!.putDataset(dataset);
				this.#metadata!.putJob(active.job);
				if (active.dataset) {
					const timeline = this.#metadata!.transformTimeline(dataset.projectId, id);
					this.#metadata!.putTransformTimeline(dataset.projectId, id, {
						undo: [],
						redo: [],
						revision: timeline.revision + 1,
					});
				}
			});
			completed = true;
		} catch (error) {
			failure =
				active.stopError ??
				(error instanceof WorkbenchError
					? error
					: new WorkbenchError(
							500,
							active.job.kind === "profile"
								? "Profiling failed. Check available disk space and permissions."
								: "Ingestion failed. Check available disk space and permissions.",
						));
		} finally {
			clearTimeout(active.idleTimer);
			clearTimeout(active.deadlineTimer);
			try {
				if (!completed && published) await rm(published, { recursive: true, force: true });
				await rm(active.stagingPath, { recursive: true, force: true });
			} catch {
				if (!completed) failure = new WorkbenchError(500, "Temporary files will be cleaned on restart.");
			}
			if (!completed && failure) {
				if (active.job.state !== "cancelled") {
					active.job.state = "failed";
					active.job.error = failure.message;
				}
				active.uploaded.reject(failure);
			}
			this.#saveJob(active.job);
			if (this.#active === active) this.#active = undefined;
			this.#jobs.delete(active.job.id);
			if (completed && active.job.kind === "profile") active.uploaded.resolve({ ...active.job });
		}
	}

	close(): Promise<void> {
		this.#closing = true;
		const transform = this.#transformWork;
		if (transform && !transform.committing)
			transform.controller.abort(new WorkbenchError(409, "Transformation was cancelled during shutdown."));
		this.#closeTask ??= this.#close();
		return this.#closeTask;
	}

	async #close(): Promise<void> {
		await this.#initializing?.catch(() => {});
		clearTimeout(this.#transformExpiry);
		const transform = this.#transformWork;
		if (transform) await transform.done.promise;
		await this.#transformCleanup;
		this.#chartController?.abort();
		await this.#chartTask?.catch(() => {});
		const active = this.#active;
		if (active) {
			this.#stop(active, new WorkbenchError(409, "Operation was cancelled during shutdown."), true);
			await active.task;
		}
		this.#previewController?.abort();
		await this.#previewTask?.catch(() => {});
		this.#profileRead?.controller.abort();
		await this.#profileRead?.task.catch(() => {});
		this.#metadata?.close();
		this.#metadata = undefined;
		this.#ready = false;
		await this.#releaseLock();
	}
}
