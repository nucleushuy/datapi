import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { ASSISTANT_OUTPUT_BYTES, ASSISTANT_TIMEOUT_MS, type AssistantUsage } from "./assistant-contracts.ts";
import {
	ASSISTANT_PROVIDERS,
	ASSISTANT_WORKER_ERRORS,
	isAssistantApiKey,
	isAssistantUsage,
} from "./assistant-driver.ts";
import type { ConversationDriver } from "./conversation-contracts.ts";
import { WorkbenchError } from "./storage.ts";

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

/** Uses Pi's persisted sessions and credential store; this class only owns the bounded child transport. */
export class PiConversationDriver implements ConversationDriver {
	readonly #authPath: string;
	readonly #credentials: AuthStorage;
	readonly #stoppers = new Set<() => void>();
	#closed = false;
	constructor(dataDir: string) {
		this.#authPath = join(dataDir, "pi", "auth.json");
		this.#credentials = AuthStorage.create(this.#authPath);
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
	}
	async chat(
		input: {
			provider: string;
			modelId: string;
			sessionFile: string | null;
			sessionDir: string;
			system: string;
			user: string;
		},
		onEvent: (event: { type: "text"; delta: string }) => void,
		signal: AbortSignal,
	): Promise<{ sessionFile: string; text: string; usage: AssistantUsage }> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (!(await this.authorizedProviders()).includes(input.provider)) throw error("credentials");
		if (signal.aborted) throw error("cancelled");
		const loader = import.meta.resolve("tsx");
		const request = JSON.stringify({ ...input, authPath: this.#authPath });
		if (Buffer.byteLength(request) > 8 * 96 * 1024) throw error("request");
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		const env: NodeJS.ProcessEnv = {
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			TSX_DISABLE_CACHE: "1",
			TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
		};
		for (const name of ["SystemRoot", "TEMP", "TMP"])
			if (process.env[name] !== undefined) env[name] = process.env[name];
		return await new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					loader,
					"--max-old-space-size=256",
					fileURLToPath(new URL("./conversation-sdk-worker.ts", import.meta.url)),
				],
				{ cwd: root, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"], env },
			);
			let output = "";
			let line = "";
			let failure: WorkbenchError | undefined;
			const stop = (code: keyof typeof ASSISTANT_WORKER_ERRORS) => {
				if (!failure) {
					failure = error(code);
					child.stdin.destroy();
					child.kill("SIGKILL");
				}
			};
			const abort = () => stop("cancelled");
			const timeout = setTimeout(() => stop("timeout"), ASSISTANT_TIMEOUT_MS);
			this.#stoppers.add(abort);
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				line += chunk;
				for (;;) {
					const index = line.indexOf("\n");
					if (index < 0) break;
					const raw = line.slice(0, index);
					line = line.slice(index + 1);
					try {
						const frame: unknown = JSON.parse(raw);
						if (!record(frame)) throw Error();
						if (frame.type === "text" && typeof frame.delta === "string") {
							output += frame.delta;
							if (Buffer.byteLength(output) > ASSISTANT_OUTPUT_BYTES) stop("output");
							else onEvent({ type: "text", delta: frame.delta });
						} else if (
							frame.type === "result" &&
							typeof frame.text === "string" &&
							typeof frame.sessionFile === "string" &&
							isAssistantUsage(frame.usage)
						) {
							output = frame.text;
							(child as typeof child & { result?: unknown }).result = {
								sessionFile: frame.sessionFile,
								text: output,
								usage: frame.usage,
							};
						} else if (
							frame.type === "error" &&
							typeof frame.code === "string" &&
							Object.hasOwn(ASSISTANT_WORKER_ERRORS, frame.code)
						)
							stop(frame.code as keyof typeof ASSISTANT_WORKER_ERRORS);
						else throw Error();
					} catch {
						stop("protocol");
					}
				}
			});
			child.once("error", () => stop("process"));
			child.once("close", (code) => {
				clearTimeout(timeout);
				this.#stoppers.delete(abort);
				signal.removeEventListener("abort", abort);
				if (failure) reject(failure);
				else {
					const result = (child as typeof child & { result?: unknown }).result;
					if (code !== 0 || line || !result) reject(error("protocol"));
					else resolve(result as { sessionFile: string; text: string; usage: AssistantUsage });
				}
			});
			child.stdin.end(request);
		});
	}
}
