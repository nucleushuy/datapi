import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import type { Dataset, ImportJob, Preview, Project } from "./contracts.ts";
import { MAX_UPLOAD_BYTES, PAGE_SIZE, PROFILE_VERSION } from "./contracts.ts";
import type { CsvWorkerMessage, CsvWorkerRequest, CsvWorkerResult } from "./profiler.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const RETAINED_JOBS = 100;
const RESERVATION_TIMEOUT_MS = 60_000;
const UPLOAD_IDLE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const PROCESSING_TIMEOUT_MS = 5 * 60_000;
const PREVIEW_BYTES = 8 * 1024 * 1024;

export class WorkbenchError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "WorkbenchError";
		this.status = status;
	}
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
	worker?: Worker;
	idleTimer?: NodeJS.Timeout;
	deadlineTimer?: NodeJS.Timeout;
	task: Promise<void>;
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
	readonly #projectWrites = new Set<Promise<Project>>();
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
			this.#ready = true;
		} catch (error) {
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

	async #project(projectId: string): Promise<Project> {
		validateId(projectId);
		return readJson<Project>(join(this.#root, "projects", projectId, "project.json"));
	}

	async listProjects(): Promise<Project[]> {
		this.#assertReady();
		const entries = await readdir(join(this.#root, "projects"), { withFileTypes: true });
		const projects: Project[] = [];
		for (const entry of entries) {
			if (entry.isDirectory() && ID.test(entry.name)) projects.push(await this.#project(entry.name));
		}
		return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	}

	async createProject(name: string): Promise<Project> {
		this.#assertReady();
		if (
			typeof name !== "string" ||
			name.trim().length === 0 ||
			name.trim().length > 120 ||
			/[\u0000-\u001f\u007f]/.test(name)
		) {
			throw new WorkbenchError(400, "Project name must contain 1 to 120 characters without control characters.");
		}
		const operation = this.#writeProject(name.trim());
		this.#projectWrites.add(operation);
		try {
			return await operation;
		} finally {
			this.#projectWrites.delete(operation);
		}
	}

	async #writeProject(name: string): Promise<Project> {
		const project: Project = { id: randomUUID(), name, createdAt: new Date().toISOString() };
		const staging = join(this.#root, "staging", project.id);
		try {
			await mkdir(staging);
			await mkdir(join(staging, "datasets"));
			await writeJson(join(staging, "project.json"), project);
			await rename(staging, join(this.#root, "projects", project.id));
			return project;
		} catch {
			throw new WorkbenchError(500, "Project could not be saved.");
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	async listDatasets(projectId: string): Promise<Dataset[]> {
		this.#assertReady();
		await this.#project(projectId);
		const entries = await readdir(join(this.#root, "projects", projectId, "datasets"), { withFileTypes: true });
		const datasets: Dataset[] = [];
		for (const entry of entries) {
			if (entry.isDirectory() && ID.test(entry.name)) datasets.push(await this.getDataset(projectId, entry.name));
		}
		return datasets.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	}

	#datasetPath(projectId: string, datasetId: string): string {
		validateId(projectId);
		validateId(datasetId);
		return join(this.#root, "projects", projectId, "datasets", datasetId);
	}

	async getDataset(projectId: string, datasetId: string): Promise<Dataset> {
		this.#assertReady();
		return readJson<Dataset>(join(this.#datasetPath(projectId, datasetId), "metadata.json"));
	}

	async preview(projectId: string, datasetId: string, offset: number): Promise<Preview> {
		this.#assertReady();
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new WorkbenchError(400, "Preview offset must be a nonnegative integer.");
		const dataset = await this.getDataset(projectId, datasetId);
		const rows: string[][] = [];
		if (offset < dataset.rowCount) {
			try {
				const directory = this.#datasetPath(projectId, datasetId);
				const page = Math.floor(offset / PAGE_SIZE);
				const index = await open(join(directory, "preview.idx"), "r");
				const pointer = Buffer.alloc(8);
				try {
					const read = await index.read(pointer, 0, 8, page * 8);
					if (read.bytesRead !== 8) throw new Error("Incomplete preview index.");
				} finally {
					await index.close();
				}
				const source = createReadStream(join(directory, "preview.jsonl"), {
					encoding: "utf8",
					start: Number(pointer.readBigUInt64LE()),
				});
				const lines = createInterface({ input: source, crlfDelay: Infinity });
				let sourceError: Error | undefined;
				source.on("error", (error) => {
					sourceError = error;
					lines.close();
				});
				let rowIndex = page * PAGE_SIZE;
				let bytes = 0;
				try {
					for await (const line of lines) {
						if (rowIndex++ < offset) continue;
						const size = Buffer.byteLength(line, "utf8") + 1;
						if (bytes + size > PREVIEW_BYTES) break;
						rows.push(JSON.parse(line) as string[]);
						bytes += size;
						if (rows.length === PAGE_SIZE) break;
					}
					if (sourceError) throw sourceError;
					if (rows.length === 0) throw new Error("Incomplete preview.");
				} finally {
					lines.close();
					source.destroy();
				}
			} catch {
				throw new WorkbenchError(500, "Stored preview could not be read.");
			}
		}
		return { offset, limit: PAGE_SIZE, total: dataset.rowCount, rows };
	}

	async createImport(projectId: string, name: string): Promise<ImportJob> {
		this.#assertReady();
		if (
			typeof name !== "string" ||
			name.trim().length === 0 ||
			name.length > 255 ||
			/[\\/\u0000-\u001f\u007f]/.test(name) ||
			name === "." ||
			name === ".."
		) {
			throw new WorkbenchError(
				400,
				"CSV filename must contain 1 to 255 characters and no path separators or control characters.",
			);
		}
		await this.#project(projectId);
		const active = this.#reserve(projectId, name, "import");
		active.task = this.#run(active);
		return { ...active.job };
	}

	#reserve(projectId: string, name: string, kind: ImportJob["kind"], dataset?: Dataset): ActiveJob {
		this.#assertReady();
		if (this.#active) throw new WorkbenchError(409, "Another import or profile job is active.");
		const job: ImportJob = {
			id: randomUUID(),
			projectId,
			name,
			kind,
			state: kind === "import" ? "uploading" : "processing",
			bytesReceived: dataset?.byteSize ?? 0,
			bytesProcessed: 0,
			rowCount: 0,
		};
		if (dataset) job.datasetId = dataset.id;
		const active: ActiveJob = {
			job,
			dataset,
			stagingPath: join(this.#root, "staging", job.id),
			source: deferred(),
			uploaded: deferred(),
			stopped: deferred(),
			claimed: false,
			committing: false,
			task: Promise.resolve(),
		};
		this.#active = active;
		this.#jobs.set(job.id, job);
		while (this.#jobs.size > RETAINED_JOBS) {
			const oldest = this.#jobs.keys().next().value;
			if (oldest) this.#jobs.delete(oldest);
		}
		if (kind === "import") this.#idleDeadline(active, RESERVATION_TIMEOUT_MS);
		return active;
	}

	getJob(jobId: string): ImportJob {
		validateId(jobId);
		const job = this.#jobs.get(jobId);
		if (!job) throw new WorkbenchError(404, "Job was not found or has expired.");
		return { ...job };
	}

	async upload(jobId: string, source: AsyncIterable<Uint8Array>): Promise<ImportJob> {
		this.#assertReady();
		this.getJob(jobId);
		const active = this.#active;
		if (!active || active.job.id !== jobId || active.job.state !== "uploading" || active.claimed) {
			throw new WorkbenchError(409, "This job cannot accept an upload.");
		}
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
		active.nextRejected?.(error);
		clearTimeout(active.idleTimer);
		clearTimeout(active.deadlineTimer);
	}

	async cancel(jobId: string): Promise<ImportJob> {
		this.getJob(jobId);
		const active = this.#active;
		if (active?.job.id === jobId) {
			this.#stop(active, new WorkbenchError(409, "Import was cancelled."), true);
			await active.task;
		}
		return this.getJob(jobId);
	}

	async reprofile(projectId: string, datasetId: string): Promise<ImportJob> {
		const dataset = await this.getDataset(projectId, datasetId);
		const active = this.#reserve(projectId, dataset.name, "reprofile", dataset);
		active.task = this.#run(active);
		return { ...active.job };
	}

	async #receive(active: ActiveJob, source: AsyncIterable<Uint8Array>): Promise<{ byteSize: number; sha256: string }> {
		const file = await open(join(active.stagingPath, "source.csv"), "wx", 0o600);
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
					throw new WorkbenchError(413, "CSV exceeds the 100 MB upload limit.");
				}
				if (item.value.byteLength === 0) continue;
				await file.writeFile(item.value);
				hash.update(item.value);
				active.job.bytesReceived += item.value.byteLength;
				this.#idleDeadline(active, UPLOAD_IDLE_TIMEOUT_MS);
			}
			if (active.stopError) throw active.stopError;
			if (active.job.bytesReceived === 0) throw new WorkbenchError(400, "CSV is empty; a header row is required.");
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

	#process(active: ActiveJob, sourcePath: string): Promise<CsvWorkerResult> {
		clearTimeout(active.idleTimer);
		clearTimeout(active.deadlineTimer);
		active.deadlineTimer = setTimeout(
			() => this.#stop(active, new WorkbenchError(408, "CSV processing exceeded its five-minute time limit.")),
			PROCESSING_TIMEOUT_MS,
		);
		active.deadlineTimer.unref();
		const worker = new Worker(new URL("./csv-worker.ts", import.meta.url), {
			workerData: {
				sourcePath,
				stagingPath: active.stagingPath,
				writePreview: active.job.kind === "import",
			} satisfies CsvWorkerRequest,
			resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
			stdout: true,
			stderr: true,
		});
		worker.stdout.resume();
		worker.stderr.resume();
		active.worker = worker;
		return new Promise<CsvWorkerResult>((resolve, reject) => {
			worker.on("message", (message: CsvWorkerMessage) => {
				if (active.stopError) return;
				if (message.type === "progress") {
					active.job.bytesProcessed = message.bytesProcessed;
					active.job.rowCount = message.rowCount;
				} else if (message.type === "result") resolve(message.result);
				else reject(new WorkbenchError(400, message.error));
			});
			worker.once("error", () =>
				reject(new WorkbenchError(500, "CSV worker failed or exceeded its 192 MB heap limit.")),
			);
			worker.once("exit", () =>
				reject(new WorkbenchError(500, "CSV worker stopped before completing the profile.")),
			);
		});
	}

	async #run(active: ActiveJob): Promise<void> {
		let failure: WorkbenchError | undefined;
		let completed = false;
		try {
			await mkdir(active.stagingPath);
			let expected: { byteSize: number; sha256: string };
			let sourcePath: string;
			if (active.dataset) {
				expected = active.dataset;
				sourcePath = join(this.#datasetPath(active.job.projectId, active.dataset.id), "source.csv");
			} else {
				const source = await Promise.race([active.source.promise, active.stopped.promise]);
				expected = await this.#receive(active, source);
				sourcePath = join(active.stagingPath, "source.csv");
			}
			if (active.stopError) throw active.stopError;
			active.job.state = "processing";
			const processing = this.#process(active, sourcePath);
			active.uploaded.resolve({ ...active.job });
			const result = await Promise.race([processing, active.stopped.promise]);
			if (active.stopError) throw active.stopError;
			if (result.sha256 !== expected.sha256 || result.byteSize !== expected.byteSize) {
				throw new WorkbenchError(409, "Preserved CSV integrity check failed; the dataset was not changed.");
			}
			if (
				active.dataset &&
				(result.rowCount !== active.dataset.rowCount || result.columns.length !== active.dataset.columnCount)
			) {
				throw new WorkbenchError(409, "Preserved CSV no longer matches the stored preview.");
			}
			const now = new Date().toISOString();
			const dataset: Dataset = {
				id: active.dataset?.id ?? randomUUID(),
				projectId: active.job.projectId,
				name: active.job.name,
				createdAt: active.dataset?.createdAt ?? now,
				byteSize: result.byteSize,
				sha256: result.sha256,
				rowCount: result.rowCount,
				columnCount: result.columns.length,
				columns: result.columns,
				parsing: { encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" },
				profileVersion: PROFILE_VERSION,
				profiledAt: now,
			};
			await writeJson(join(active.stagingPath, "metadata.json"), dataset);
			if (active.stopError) throw active.stopError;
			// Cancellation after this linearization point waits for the atomic rename.
			active.committing = true;
			clearTimeout(active.deadlineTimer);
			const destination = this.#datasetPath(dataset.projectId, dataset.id);
			if (active.dataset)
				await rename(join(active.stagingPath, "metadata.json"), join(destination, "metadata.json"));
			else await rename(active.stagingPath, destination);
			active.job.datasetId = dataset.id;
			active.job.bytesProcessed = result.byteSize;
			active.job.rowCount = result.rowCount;
			completed = true;
		} catch (error) {
			failure =
				active.stopError ??
				(error instanceof WorkbenchError
					? error
					: new WorkbenchError(500, "Import failed; check the file and available disk space."));
		} finally {
			clearTimeout(active.idleTimer);
			clearTimeout(active.deadlineTimer);
			try {
				await active.worker?.terminate();
				await rm(active.stagingPath, { recursive: true, force: true });
			} catch {
				// Startup retries cleanup under the exclusive root owner lock.
				if (!completed)
					failure = new WorkbenchError(500, "Job stopped; temporary files will be cleaned on restart.");
			}
			if (this.#active === active) this.#active = undefined;
			if (completed) active.job.state = "completed";
			else if (failure) {
				if (active.job.state !== "cancelled") {
					active.job.state = "failed";
					active.job.error = failure.message;
				}
				active.uploaded.reject(failure);
			}
		}
	}

	close(): Promise<void> {
		this.#closing = true;
		this.#closeTask ??= this.#close();
		return this.#closeTask;
	}

	async #close(): Promise<void> {
		await this.#initializing?.catch(() => {});
		const active = this.#active;
		if (active) {
			this.#stop(active, new WorkbenchError(409, "Import was cancelled during shutdown."), true);
			await active.task;
		}
		await Promise.allSettled(this.#projectWrites);
		this.#ready = false;
		await this.#releaseLock();
	}
}
