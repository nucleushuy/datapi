import { type ChildProcessByStdio, spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ASSISTANT_OUTPUT_BYTES, ASSISTANT_TIMEOUT_MS, type AssistantUsage } from "./assistant-contracts.ts";
import {
	ASSISTANT_PROVIDERS,
	ASSISTANT_REQUEST_BYTES,
	ASSISTANT_WORKER_ERRORS,
	isAssistantApiKey,
	isAssistantUsage,
} from "./assistant-driver.ts";
import type { ConversationDriver } from "./conversation-contracts.ts";
import { WorkbenchError } from "./storage.ts";

type ConversationChild = ChildProcessByStdio<Writable, Readable, null>;
type LaunchConversationWorker = () => ConversationChild;
interface ConversationResult {
	sessionFile: string;
	text: string;
	usage: AssistantUsage;
}

function error(code: keyof typeof ASSISTANT_WORKER_ERRORS): WorkbenchError {
	const status =
		code === "credentials"
			? 409
			: code === "cancelled"
				? 499
				: code === "timeout"
					? 504
					: code === "request" || code === "model"
						? 400
						: 502;
	return new WorkbenchError(status, ASSISTANT_WORKER_ERRORS[code]);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
	return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function launchWorker(): ConversationChild {
	const env: NodeJS.ProcessEnv = {
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		TSX_DISABLE_CACHE: "1",
		TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
	};
	for (const name of ["SystemRoot", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name];
	return spawn(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			"--max-old-space-size=256",
			fileURLToPath(new URL("./conversation-sdk-worker.ts", import.meta.url)),
		],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			windowsHide: true,
			shell: false,
			stdio: ["pipe", "pipe", "ignore"],
			env,
		},
	);
}

/** Uses Pi's persisted sessions and credential store; this class only owns the bounded child transport. */
export class PiConversationDriver implements ConversationDriver {
	readonly #authPath: string;
	readonly #credentials: AuthStorage;
	readonly #launchWorker: LaunchConversationWorker;
	readonly #stoppers = new Set<() => void>();
	readonly #pending = new Set<Promise<unknown>>();
	#closed = false;
	constructor(dataDir: string, worker: LaunchConversationWorker = launchWorker) {
		this.#authPath = join(dataDir, "pi", "auth.json");
		this.#credentials = AuthStorage.create(this.#authPath);
		this.#launchWorker = worker;
	}
	async authorizedProviders(): Promise<readonly string[]> {
		const credentials = await this.#credentials.list();
		return credentials
			.filter((credential) => credential.type === "api_key" && ASSISTANT_PROVIDERS.has(credential.providerId))
			.map((credential) => credential.providerId);
	}
	async setCredential(provider: unknown, apiKey: unknown): Promise<void> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (typeof provider !== "string" || !ASSISTANT_PROVIDERS.has(provider) || !isAssistantApiKey(apiKey))
			throw new WorkbenchError(
				400,
				"Use a supported provider and a literal API key of 8–8192 characters; commands, environment templates, and whitespace are not accepted.",
			);
		await this.#credentials.modify(provider, async () => ({ type: "api_key", key: apiKey }));
	}
	async deleteCredential(provider: string): Promise<void> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (!ASSISTANT_PROVIDERS.has(provider)) throw new WorkbenchError(400, "Use a supported provider.");
		await this.#credentials.delete(provider);
	}
	async close(): Promise<void> {
		this.#closed = true;
		for (const stop of this.#stoppers) stop();
		await Promise.allSettled(this.#pending);
	}
	async chat(
		input: Parameters<ConversationDriver["chat"]>[0],
		onEvent: Parameters<ConversationDriver["chat"]>[1],
		signal: AbortSignal,
	): Promise<ConversationResult> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (signal.aborted) throw error("cancelled");
		if (!(await this.authorizedProviders()).includes(input.provider)) throw error("credentials");
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (signal.aborted) throw error("cancelled");
		const request = JSON.stringify({ ...input, authPath: this.#authPath });
		if (Buffer.byteLength(request) > ASSISTANT_REQUEST_BYTES) throw error("request");
		const task = new Promise<ConversationResult>((resolve, reject) => {
			let child: ConversationChild;
			try {
				child = this.#launchWorker();
			} catch {
				reject(error("process"));
				return;
			}
			let output = "";
			let outputBytes = 0;
			let receivedBytes = 0;
			let lineBytes = 0;
			let fragments: Buffer[] = [];
			let result: ConversationResult | undefined;
			let failure: WorkbenchError | undefined;
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const stop = (code: keyof typeof ASSISTANT_WORKER_ERRORS) => {
				if (!failure) {
					failure = error(code);
					child.stdin.destroy();
					child.kill("SIGKILL");
				}
			};
			const consume = (raw: Buffer) => {
				const frame: unknown = JSON.parse(decoder.decode(raw));
				if (!record(frame) || result) throw Error();
				if (frame.type === "text" && keys(frame, ["type", "delta"]) && typeof frame.delta === "string") {
					outputBytes += Buffer.byteLength(frame.delta);
					if (outputBytes > ASSISTANT_OUTPUT_BYTES) return stop("output");
					output += frame.delta;
					onEvent({ type: "text", delta: frame.delta });
				} else if (
					frame.type === "result" &&
					keys(frame, ["type", "text", "sessionFile", "usage"]) &&
					frame.text === output &&
					output.length > 0 &&
					typeof frame.sessionFile === "string" &&
					frame.sessionFile.length > 0 &&
					frame.sessionFile.length <= 4096 &&
					!frame.sessionFile.includes("\0") &&
					isAssistantUsage(frame.usage)
				) {
					result = { sessionFile: frame.sessionFile, text: output, usage: frame.usage };
				} else if (
					frame.type === "error" &&
					keys(frame, ["type", "code"]) &&
					typeof frame.code === "string" &&
					Object.hasOwn(ASSISTANT_WORKER_ERRORS, frame.code)
				)
					stop(frame.code as keyof typeof ASSISTANT_WORKER_ERRORS);
				else throw Error();
			};
			const abort = () => stop("cancelled");
			const timeout = setTimeout(() => stop("timeout"), ASSISTANT_TIMEOUT_MS);
			this.#stoppers.add(abort);
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				if (failure) return;
				try {
					// Worst case: one-byte text deltas, JSON escaping, and the final repeated text.
					receivedBytes += chunk.length;
					if (receivedBytes > 40 * ASSISTANT_OUTPUT_BYTES + 8192) throw Error();
					let start = 0;
					while (start < chunk.length && !failure) {
						if (result) throw Error();
						const newline = chunk.indexOf(10, start);
						const end = newline < 0 ? chunk.length : newline;
						const piece = chunk.subarray(start, end);
						lineBytes += piece.length;
						if (lineBytes > 6 * ASSISTANT_OUTPUT_BYTES + 8192) throw Error();
						fragments.push(piece);
						if (newline < 0) break;
						consume(fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, lineBytes));
						fragments = [];
						lineBytes = 0;
						start = newline + 1;
					}
				} catch {
					stop("protocol");
				}
			});
			child.once("error", () => stop("process"));
			child.stdin.on("error", () => stop("process"));
			child.stdout.on("error", () => stop("process"));
			child.once("close", (code, exitSignal) => {
				clearTimeout(timeout);
				this.#stoppers.delete(abort);
				signal.removeEventListener("abort", abort);
				if (failure) reject(failure);
				else if (code !== 0 || exitSignal !== null) reject(error("process"));
				else if (lineBytes || !result) reject(error("protocol"));
				else resolve(result);
			});
			if (signal.aborted) abort();
			if (!failure) child.stdin.end(request);
		});
		this.#pending.add(task);
		try {
			return await task;
		} finally {
			this.#pending.delete(task);
		}
	}
}
