import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSISTANT_REQUEST_BYTES, ASSISTANT_WORKER_ERRORS } from "../src/assistant-driver.ts";
import { PiConversationDriver } from "../src/conversation-driver.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const worker = fileURLToPath(new URL("../src/conversation-sdk-worker.ts", import.meta.url));
const proof = fileURLToPath(new URL("./fixtures/conversation-sdk-proof.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/conversation-sdk-child.ts", import.meta.url));
function launch(path: string, args: string[] = []): ChildProcessByStdio<Writable, Readable, null> {
	const env: NodeJS.ProcessEnv = {
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		TSX_DISABLE_CACHE: "1",
		TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
	};
	for (const name of ["SystemRoot", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name];
	return spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--max-old-space-size=256", path, ...args], {
		cwd: root,
		env,
		shell: false,
		windowsHide: true,
		stdio: ["pipe", "pipe", "ignore"],
	});
}
async function run(path: string, input: Buffer | string): Promise<{ code: number | null; stdout: string }> {
	const child = launch(path);
	const parts: Buffer[] = [];
	let bytes = 0;
	child.stdout.on("data", (part: Buffer) => {
		bytes += part.length;
		if (bytes > 2 * 1024 * 1024) child.kill("SIGKILL");
		else parts.push(part);
	});
	child.stdin.on("error", () => {});
	const watchdog = setTimeout(() => child.kill("SIGKILL"), 90_000);
	try {
		const completion = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, stdout: Buffer.concat(parts).toString("utf8") }));
		});
		child.stdin.end(input);
		return await completion;
	} finally {
		clearTimeout(watchdog);
	}
}
function input(dataDir: string) {
	return {
		provider: "openai",
		modelId: "fixture",
		sessionFile: null,
		sessionDir: join(dataDir, "sessions"),
		system: `Read-only approved conversation.\nCurrent working directory: ${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n`,
		user: "Explain the frozen context.",
	};
}

describe("Pi conversation worker and child boundary", { concurrency: false, timeout: 180_000 }, () => {
	it("proves real SDK streaming, exact frozen payload, disk resume, cancellation, and safe failures offline", async () => {
		const result = await run(proof, "");
		assert.equal(result.code, 0, result.stdout);
		assert.equal(result.stdout, "CONVERSATION_SDK_PROOF_OK\n");
	});
	it("streams production driver text before its result and resumes the same session", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chat-driver-"));
		const driver = new PiConversationDriver(dataDir, () => launch(fixture));
		t.after(async () => {
			await driver.close();
			await rm(dataDir, { recursive: true, force: true });
		});
		await driver.setCredential("openai", "literal-test-not-a-real-key");
		const deltas: string[] = [];
		let complete = false;
		let receivedBeforeResult = false;
		const first = await driver
			.chat(
				input(dataDir),
				({ delta }) => {
					receivedBeforeResult ||= !complete;
					deltas.push(delta);
				},
				new AbortController().signal,
			)
			.then((result) => {
				complete = true;
				return result;
			});
		assert.equal(receivedBeforeResult, true);
		assert.ok(deltas.length > 1);
		assert.equal(deltas.join(""), first.text);
		const next = await driver.chat(
			{ ...input(dataDir), sessionFile: first.sessionFile, user: "Follow up." },
			() => {},
			new AbortController().signal,
		);
		assert.equal(next.sessionFile, first.sessionFile);
	});
	it("cancels active and pre-start children, closes pending work, and normalizes provider failures", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chat-cancel-"));
		const driver = new PiConversationDriver(dataDir, () => launch(fixture, ["cancel"]));
		const failing = new PiConversationDriver(dataDir, () => launch(fixture, ["provider-error"]));
		t.after(async () => {
			await driver.close();
			await failing.close();
			await rm(dataDir, { recursive: true, force: true });
		});
		await driver.setCredential("openai", "literal-test-not-a-real-key");
		await assert.rejects(
			driver.chat(input(dataDir), () => {}, AbortSignal.abort()),
			{ message: ASSISTANT_WORKER_ERRORS.cancelled },
		);
		const signal = new AbortController();
		let deltas = 0;
		await assert.rejects(
			driver.chat(
				input(dataDir),
				() => {
					deltas++;
					signal.abort();
				},
				signal.signal,
			),
			{ message: ASSISTANT_WORKER_ERRORS.cancelled },
		);
		assert.equal(deltas, 1);
		await assert.rejects(
			failing.chat(input(dataDir), () => {}, new AbortController().signal),
			{ message: ASSISTANT_WORKER_ERRORS.provider },
		);
		let closing: Promise<void> | undefined;
		await assert.rejects(
			driver.chat(
				input(dataDir),
				() => {
					closing = driver.close();
				},
				new AbortController().signal,
			),
			{ message: ASSISTANT_WORKER_ERRORS.cancelled },
		);
		await closing;
		await assert.rejects(
			driver.chat(input(dataDir), () => {}, new AbortController().signal),
			{ status: 503 },
		);
	});
	it("rejects final-text substitution, frames after terminal, invalid UTF-8, and unbounded lines", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chat-protocol-"));
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		for (const mode of ["mismatch", "after-result", "utf8", "oversized-line"]) {
			const driver = new PiConversationDriver(dataDir, () => launch(fixture, [mode]));
			try {
				await driver.setCredential("openai", "literal-test-not-a-real-key");
				await assert.rejects(
					driver.chat(input(dataDir), () => {}, new AbortController().signal),
					{ message: ASSISTANT_WORKER_ERRORS.protocol },
					mode,
				);
			} finally {
				await driver.close();
			}
		}
	});
	it("bounds and validates stdin before credential or provider work", async () => {
		for (const value of [Buffer.from([0xff]), Buffer.alloc(ASSISTANT_REQUEST_BYTES + 1, 32), "null"]) {
			const result = await run(worker, value);
			assert.equal(result.code, 0);
			assert.equal(result.stdout, '{"type":"error","code":"request"}\n');
		}
	});
});
