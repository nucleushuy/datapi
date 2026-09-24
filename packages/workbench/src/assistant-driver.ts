import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	ASSISTANT_CONTEXT_BYTES,
	ASSISTANT_OUTPUT_BYTES,
	ASSISTANT_TIMEOUT_MS,
	type AssistantDriver,
	type AssistantModels,
	type AssistantPayload,
	type AssistantProgress,
	type AssistantUsage,
} from "./assistant-contracts.ts";
import { WorkbenchError } from "./storage.ts";

// Only built-in providers with self-contained literal API-key authentication are offered.
export const ASSISTANT_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"openai",
	"google",
	"mistral",
	"xai",
	"groq",
	"openrouter",
	"cerebras",
]);
export const ASSISTANT_REQUEST_BYTES = 8 * ASSISTANT_CONTEXT_BYTES;
export const ASSISTANT_CATALOG_BYTES = 2 * 1024 * 1024;
const RESULT_FRAME_BYTES = 6 * ASSISTANT_OUTPUT_BYTES + 4096;
const PROGRESS_BYTES = 64 * 1024;
export const ASSISTANT_GUIDANCE =
	"Authorize a provider with its literal API key. Pi stores the credential in the local workbench credential store; the browser never receives it after setup. Model discovery is offline; only an explicitly approved run sends the displayed system and user messages to the selected provider through the Pi SDK.";
export const ASSISTANT_WORKER_ERRORS = {
	request: "Assistant request is invalid.",
	credentials: "Configure an API key for the selected assistant provider.",
	model: "The selected assistant model is unavailable.",
	context: "Assistant session context did not match the approved payload.",
	provider:
		"The assistant provider could not complete this request. Check the configured key and model, then try again.",
	output: "Assistant output exceeded its limit or was incomplete.",
	protocol: "Assistant worker returned an invalid response.",
	process: "Assistant worker stopped unexpectedly or exceeded its memory limit.",
	cancelled: "Assistant request was cancelled.",
	timeout: "Assistant request exceeded the five-minute limit.",
} as const;
export type AssistantWorkerErrorCode = keyof typeof ASSISTANT_WORKER_ERRORS;
export type AssistantWorkerRequest =
	| { operation: "models"; credentials: Record<string, string> }
	| {
			operation: "generate";
			credentials: Record<string, string>;
			provider: string;
			modelId: string;
			payload: AssistantPayload;
	  };
type Generation = { text: string; usage: AssistantUsage };
type WorkerResult = AssistantModels | Generation;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function label(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		!/[\u0000-\u001f\u007f-\u009f]/u.test(value)
	);
}
export function isAssistantApiKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 8192 &&
		value.trim() === value &&
		!value.startsWith("!") &&
		!/[$`\u0000-\u0020\u007f-\u009f]/u.test(value)
	);
}
export function isAssistantUsage(value: unknown): value is AssistantUsage {
	return (
		record(value) &&
		keys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) &&
		Object.values(value).every(count)
	);
}
function workerError(code: AssistantWorkerErrorCode): WorkbenchError {
	const status =
		code === "request" || code === "model"
			? 400
			: code === "credentials"
				? 409
				: code === "cancelled"
					? 499
					: code === "timeout"
						? 504
						: 502;
	return new WorkbenchError(status, ASSISTANT_WORKER_ERRORS[code]);
}

/** Revalidate the whole bounded envelope at the process boundary; never resolve key templates. */
export function parseAssistantWorkerRequest(value: unknown): AssistantWorkerRequest {
	if (
		!record(value) ||
		!record(value.credentials) ||
		Object.entries(value.credentials).some(
			([provider, key]) => !ASSISTANT_PROVIDERS.has(provider) || !isAssistantApiKey(key),
		)
	)
		throw workerError("request");
	if (
		value.operation === "models" &&
		keys(value, ["operation", "credentials"]) &&
		Object.keys(value.credentials).length === 0
	)
		return value as AssistantWorkerRequest;
	if (
		value.operation !== "generate" ||
		!keys(value, ["operation", "credentials", "provider", "modelId", "payload"]) ||
		typeof value.provider !== "string" ||
		!ASSISTANT_PROVIDERS.has(value.provider) ||
		!label(value.modelId) ||
		Object.keys(value.credentials).some((provider) => provider !== value.provider) ||
		!record(value.payload) ||
		!keys(value.payload, ["system", "user"]) ||
		typeof value.payload.system !== "string" ||
		typeof value.payload.user !== "string" ||
		value.payload.system.length === 0 ||
		value.payload.user.length === 0 ||
		Buffer.byteLength(value.payload.system) + Buffer.byteLength(value.payload.user) > ASSISTANT_CONTEXT_BYTES
	)
		throw workerError("request");
	return value as AssistantWorkerRequest;
}

/** Incremental strict NDJSON decoder, shared by the live transport and its boundary tests. */
export class AssistantResponseDecoder {
	readonly #operation: AssistantWorkerRequest["operation"];
	readonly #onProgress?: (progress: AssistantProgress) => void;
	readonly #decoder = new TextDecoder("utf-8", { fatal: true });
	#fragments: Buffer[] = [];
	#lineBytes = 0;
	#receivedBytes = 0;
	#progressBytes = 0;
	#characters = 0;
	#terminal?: WorkerResult | WorkbenchError;

	constructor(operation: AssistantWorkerRequest["operation"], onProgress?: (progress: AssistantProgress) => void) {
		this.#operation = operation;
		this.#onProgress = onProgress;
	}
	push(chunk: Buffer): void {
		const frameLimit = this.#operation === "models" ? ASSISTANT_CATALOG_BYTES : RESULT_FRAME_BYTES;
		this.#receivedBytes += chunk.length;
		if (this.#receivedBytes > frameLimit + PROGRESS_BYTES) throw workerError("protocol");
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			const piece = chunk.subarray(start, end);
			this.#lineBytes += piece.length;
			if (this.#lineBytes > frameLimit || this.#terminal !== undefined) throw workerError("protocol");
			this.#fragments.push(piece);
			if (newline < 0) break;
			const line =
				this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments, this.#lineBytes);
			this.#consume(line);
			this.#fragments = [];
			this.#lineBytes = 0;
			start = newline + 1;
		}
	}
	#consume(line: Buffer): void {
		let frame: unknown;
		try {
			frame = JSON.parse(this.#decoder.decode(line));
		} catch {
			throw workerError("protocol");
		}
		if (!record(frame)) throw workerError("protocol");
		if (
			frame.type === "error" &&
			keys(frame, ["type", "code"]) &&
			typeof frame.code === "string" &&
			Object.hasOwn(ASSISTANT_WORKER_ERRORS, frame.code)
		) {
			this.#terminal = workerError(frame.code as AssistantWorkerErrorCode);
			return;
		}
		if (this.#operation === "models") {
			if (frame.type !== "models" || !keys(frame, ["type", "models"]) || !Array.isArray(frame.models))
				throw workerError("protocol");
			const seen = new Set<string>();
			for (const model of frame.models) {
				if (
					!record(model) ||
					!keys(model, ["provider", "id", "name", "configured", "contextWindow"]) ||
					typeof model.provider !== "string" ||
					!ASSISTANT_PROVIDERS.has(model.provider) ||
					!label(model.id) ||
					!label(model.name) ||
					typeof model.configured !== "boolean" ||
					!count(model.contextWindow) ||
					model.contextWindow === 0
				)
					throw workerError("protocol");
				const id = `${model.provider}\0${model.id}`;
				if (seen.has(id)) throw workerError("protocol");
				seen.add(id);
			}
			this.#terminal = { models: frame.models, guidance: ASSISTANT_GUIDANCE } as AssistantModels;
			return;
		}
		if (
			frame.type === "result" &&
			keys(frame, ["type", "text", "usage"]) &&
			typeof frame.text === "string" &&
			frame.text.length > 0 &&
			Buffer.byteLength(frame.text) <= ASSISTANT_OUTPUT_BYTES &&
			isAssistantUsage(frame.usage)
		) {
			if (frame.text.length < this.#characters) throw workerError("protocol");
			this.#terminal = { text: frame.text, usage: frame.usage };
			return;
		}
		this.#progressBytes += line.length + 1;
		if (this.#progressBytes > PROGRESS_BYTES) throw workerError("protocol");
		if (
			frame.type === "progress" &&
			keys(frame, ["type", "receivedCharacters"]) &&
			count(frame.receivedCharacters) &&
			frame.receivedCharacters >= this.#characters &&
			frame.receivedCharacters <= ASSISTANT_OUTPUT_BYTES
		) {
			this.#characters = frame.receivedCharacters;
			this.#onProgress?.({ type: "progress", receivedCharacters: frame.receivedCharacters });
		} else if (frame.type === "usage" && keys(frame, ["type", "usage"]) && isAssistantUsage(frame.usage)) {
			this.#onProgress?.({ type: "usage", usage: frame.usage });
		} else throw workerError("protocol");
	}
	finish(): WorkerResult {
		if (this.#lineBytes !== 0 || this.#terminal === undefined) throw workerError("protocol");
		if (this.#terminal instanceof WorkbenchError) throw this.#terminal;
		return this.#terminal;
	}
}

/** Fresh fixed-script child per operation. This is isolation from ambient SDK state, not a user-code sandbox. */
export class PiAssistantDriver implements AssistantDriver {
	readonly #credentials = new Map<string, string>();
	readonly #stoppers = new Set<() => void>();
	readonly #pending = new Set<Promise<WorkerResult>>();
	#closed = false;
	#catalog?: Promise<AssistantModels>;
	#catalogController?: AbortController;

	async setCredential(provider: unknown, apiKey: unknown): Promise<void> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (typeof provider !== "string" || !ASSISTANT_PROVIDERS.has(provider) || !isAssistantApiKey(apiKey))
			throw new WorkbenchError(
				400,
				"Use a supported provider and a literal API key of 8–8192 characters; commands, environment templates, and whitespace are not accepted.",
			);
		this.#credentials.set(provider, apiKey);
	}
	async deleteCredential(provider: string): Promise<void> {
		if (!ASSISTANT_PROVIDERS.has(provider)) throw workerError("request");
		this.#credentials.delete(provider);
	}
	async close(): Promise<void> {
		this.#closed = true;
		this.#credentials.clear();
		for (const stop of this.#stoppers) stop();
		await Promise.allSettled(this.#pending);
	}
	async models(signal?: AbortSignal): Promise<AssistantModels> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (signal?.aborted) throw workerError("cancelled");
		if (!this.#catalog) {
			this.#catalogController = new AbortController();
			const catalog = this.#run({ operation: "models", credentials: {} }, undefined, this.#catalogController.signal)
				.then((result) => result as AssistantModels)
				.catch((error: unknown) => {
					if (this.#catalog === catalog) this.#catalog = undefined;
					throw error;
				});
			this.#catalog = catalog;
		}
		const controller = this.#catalogController;
		// Coalesced discovery is one process: cancellation stops it for all current waiters.
		const abort = () => controller?.abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const catalog = await this.#catalog;
			if (signal?.aborted) throw workerError("cancelled");
			if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
			return {
				guidance: ASSISTANT_GUIDANCE,
				models: catalog.models.map((model) => ({ ...model, configured: this.#credentials.has(model.provider) })),
			};
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	async generate(
		input: { provider: string; modelId: string; payload: AssistantPayload },
		onProgress: (progress: AssistantProgress) => void,
		signal: AbortSignal,
	): Promise<Generation> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (signal.aborted) throw workerError("cancelled");
		const key = this.#credentials.get(input.provider);
		const request = parseAssistantWorkerRequest({
			operation: "generate",
			...input,
			credentials: key ? { [input.provider]: key } : {},
		});
		if (!key) throw workerError("credentials");
		return (await this.#run(request, onProgress, signal)) as Generation;
	}
	async #run(
		request: AssistantWorkerRequest,
		onProgress?: (progress: AssistantProgress) => void,
		signal?: AbortSignal,
	): Promise<WorkerResult> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (signal?.aborted) throw workerError("cancelled");
		parseAssistantWorkerRequest(request);
		const encoded = JSON.stringify(request);
		if (Buffer.byteLength(encoded) > ASSISTANT_REQUEST_BYTES) throw workerError("request");
		let loader: string;
		try {
			loader = import.meta.resolve("tsx");
		} catch {
			throw workerError("process");
		}
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		const env: NodeJS.ProcessEnv = {
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			TSX_DISABLE_CACHE: "1",
			TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
		};
		for (const name of ["SystemRoot", "TEMP", "TMP"]) {
			const value = process.env[name];
			if (value !== undefined) env[name] = value;
		}
		const task = new Promise<WorkerResult>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					loader,
					"--max-old-space-size=256",
					fileURLToPath(new URL("./assistant-sdk-worker.ts", import.meta.url)),
				],
				{
					cwd: root,
					windowsHide: true,
					shell: false,
					stdio: ["pipe", "pipe", "ignore"],
					env,
				},
			);
			const decoder = new AssistantResponseDecoder(request.operation, onProgress);
			let failure: WorkbenchError | undefined;
			const stop = (code: AssistantWorkerErrorCode) => {
				if (failure) return;
				failure = workerError(code);
				child.stdin.destroy();
				child.kill("SIGKILL");
			};
			const abort = () => stop("cancelled");
			this.#stoppers.add(abort);
			const timeout = setTimeout(() => stop("timeout"), ASSISTANT_TIMEOUT_MS);
			signal?.addEventListener("abort", abort, { once: true });
			child.on("error", () => stop("process"));
			child.stdin.on("error", () => stop("process"));
			child.stdout.on("data", (chunk: Buffer) => {
				if (failure) return;
				try {
					decoder.push(chunk);
				} catch {
					stop("protocol");
				}
			});
			child.once("close", (code, exitSignal) => {
				clearTimeout(timeout);
				this.#stoppers.delete(abort);
				signal?.removeEventListener("abort", abort);
				if (failure) return reject(failure);
				if (code !== 0 || exitSignal !== null) return reject(workerError("process"));
				try {
					resolve(decoder.finish());
				} catch (error) {
					reject(error);
				}
			});
			if (signal?.aborted) abort();
			if (!failure) child.stdin.end(encoded);
		});
		this.#pending.add(task);
		try {
			return await task;
		} finally {
			this.#pending.delete(task);
		}
	}
}
