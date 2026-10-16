import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSISTANT_REQUEST_BYTES, ASSISTANT_WORKER_ERRORS } from "../src/assistant-driver.ts";
import type { ConversationDriverEvent } from "../src/conversation-contracts.ts";
import { PiConversationDriver } from "../src/conversation-driver.ts";
import { fauxConversationChart, fauxConversationChartScope } from "./fixtures/conversation-faux-driver.ts";

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

// Real SDK subprocesses run serially; chart-frame coverage alone takes about 90 seconds.
describe("Pi conversation worker and child boundary", { concurrency: false, timeout: 480_000 }, () => {
	it("proves real SDK streaming, exact frozen payload, disk resume, cancellation, and safe failures offline", async () => {
		const result = await run(proof, "");
		assert.equal(result.code, 0, result.stdout);
		assert.equal(result.stdout, "CONVERSATION_SDK_PROOF_OK\n");
	});
	it("streams production driver text and resumes into an independent transcript snapshot", async (t) => {
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
				(event) => {
					assert.equal(event.type, "text");
					if (event.type !== "text") return;
					receivedBeforeResult ||= !complete;
					deltas.push(event.delta);
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
		const published = await readFile(first.sessionFile, "utf8");
		const next = await driver.chat(
			{ ...input(dataDir), sessionFile: first.sessionFile, user: "Follow up." },
			() => {},
			new AbortController().signal,
		);
		assert.notEqual(next.sessionFile, first.sessionFile);
		assert.equal(await readFile(first.sessionFile, "utf8"), published);
	});
	it("emits typed SDK proposals through the production subprocess without applying them", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chat-rename-"));
		const driver = new PiConversationDriver(dataDir, () => launch(fixture, ["rename"]));
		t.after(async () => {
			await driver.close();
			await rm(dataDir, { recursive: true, force: true });
		});
		await driver.setCredential("openai", "literal-test-not-a-real-key");
		const events: ConversationDriverEvent[] = [];
		const result = await driver.chat(
			{
				...input(dataDir),
				renameScope: {
					datasetVersionId: "v1",
					columns: [
						{ index: 0, name: "group" },
						{ index: 1, name: "value" },
					],
				},
			},
			(event) => events.push(event),
			new AbortController().signal,
		);
		assert.deepEqual(
			events.filter((event) => event.type === "rename_proposal"),
			[
				{
					type: "rename_proposal",
					toolCallId: "rename-child",
					datasetVersionId: "v1",
					column: 0,
					name: "cohort",
				},
			],
		);
		assert.equal(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.delta)
				.join(""),
			result.text,
		);
		assert.equal(
			result.text,
			"I can propose that rename. Awaiting local review; no dataset change has been applied.",
		);
		assert.deepEqual(Object.keys(result).sort(), ["sessionFile", "text", "usage"]);
	});
	it("emits chart-only and mixed proposals through the SDK subprocess with safe acknowledgements", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chat-chart-"));
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		const chartScope = fauxConversationChartScope();
		for (const mode of ["chart", "chart-mixed"]) {
			const driver = new PiConversationDriver(dataDir, () => launch(fixture, [mode]));
			try {
				await driver.setCredential("openai", "literal-test-not-a-real-key");
				const events: ConversationDriverEvent[] = [];
				const result = await driver.chat(
					{
						...input(dataDir),
						chartScope,
						...(mode === "chart-mixed"
							? {
									renameScope: {
										datasetVersionId: "v1",
										columns: [
											{ index: 0, name: "group" },
											{ index: 1, name: "value" },
										],
									},
								}
							: {}),
					},
					(event) => events.push(event),
					new AbortController().signal,
				);
				assert.deepEqual(
					events.filter((event) => event.type === "chart_proposal"),
					[{ type: "chart_proposal", toolCallId: "chart-child", ...fauxConversationChart(chartScope) }],
				);
				assert.equal(
					events.filter((event) => event.type === "rename_proposal").length,
					mode === "chart-mixed" ? 1 : 0,
				);
				assert.equal(
					events
						.filter((event) => event.type === "text")
						.map((event) => event.delta)
						.join(""),
					result.text,
				);
				assert.equal(
					result.text,
					"Chart awaits local preview and explicit save or reject. No chart or dataset change has been applied.",
				);
				assert.deepEqual(Object.keys(result).sort(), ["sessionFile", "text", "usage"]);
				const messages = (await readFile(result.sessionFile, "utf8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
					.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
					.map((entry) => entry.message);
				const ack = messages.find((message) => message.toolName === "propose_chart");
				assert.ok(ack);
				assert.equal(ack.isError, false);
				assert.deepEqual(ack.content, [
					{
						type: "text",
						text: JSON.stringify({ status: "awaiting_review", toolCallId: "chart-child", applied: false }),
					},
				]);
			} finally {
				await driver.close();
			}
		}
	});
	it("independently rejects invalid chart frames and shared count, identity and serialized-output excesses", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chart-protocol-"));
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		for (const mode of [
			"chart-proposal-no-scope",
			"chart-proposal-extra",
			"chart-proposal-stale",
			"chart-proposal-hidden",
			"chart-proposal-evidence",
			"chart-proposal-affected",
			"chart-proposal-coercion",
			"chart-proposal-model-result",
			"chart-proposal-mixed-duplicate",
			"chart-proposal-mixed-over-limit",
			"chart-proposal-bytes",
			"chart-proposal-text-bytes",
		]) {
			const driver = new PiConversationDriver(dataDir, () => launch(fixture, [mode]));
			try {
				await driver.setCredential("openai", "literal-test-not-a-real-key");
				await assert.rejects(
					driver.chat(
						{
							...input(dataDir),
							...(mode === "chart-proposal-no-scope" ? {} : { chartScope: fauxConversationChartScope() }),
							renameScope: {
								datasetVersionId: "v1",
								columns: [
									{ index: 0, name: "group" },
									{ index: 1, name: "value" },
								],
							},
						},
						() => {},
						new AbortController().signal,
					),
					{ message: mode.endsWith("bytes") ? ASSISTANT_WORKER_ERRORS.output : ASSISTANT_WORKER_ERRORS.protocol },
					mode,
				);
			} finally {
				await driver.close();
			}
		}
	});
	it("keeps the committed subprocess transcript unchanged when a chart turn fails or is cancelled", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chart-failed-turn-"));
		let mode = "success";
		const driver = new PiConversationDriver(dataDir, () => launch(fixture, [mode]));
		t.after(async () => {
			await driver.close();
			await rm(dataDir, { recursive: true, force: true });
		});
		await driver.setCredential("openai", "literal-test-not-a-real-key");
		const committed = await driver.chat(input(dataDir), () => {}, new AbortController().signal);
		const published = await readFile(committed.sessionFile, "utf8");
		for (const outcome of ["failure", "cancel"]) {
			mode = outcome === "failure" ? "chart-failure" : "chart";
			const controller = new AbortController();
			let proposals = 0;
			await assert.rejects(
				driver.chat(
					{ ...input(dataDir), sessionFile: committed.sessionFile, chartScope: fauxConversationChartScope() },
					(event) => {
						if (event.type === "chart_proposal") {
							proposals++;
							if (outcome === "cancel") controller.abort();
						}
					},
					controller.signal,
				),
				{ message: outcome === "cancel" ? ASSISTANT_WORKER_ERRORS.cancelled : ASSISTANT_WORKER_ERRORS.provider },
			);
			assert.equal(proposals, 1);
			assert.equal(await readFile(committed.sessionFile, "utf8"), published);
		}
	});
	it("fails closed on ungranted, malformed, stale, hidden or excessive proposal frames", async (t) => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-chat-proposal-protocol-"));
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		for (const mode of [
			"proposal-no-scope",
			"proposal-extra",
			"proposal-stale",
			"proposal-hidden",
			"proposal-duplicate-name",
			"proposal-fractional",
			"proposal-invalid-name",
			"proposal-duplicate-id",
			"proposal-over-limit",
		]) {
			const driver = new PiConversationDriver(dataDir, () => launch(fixture, [mode]));
			try {
				await driver.setCredential("openai", "literal-test-not-a-real-key");
				await assert.rejects(
					driver.chat(
						{
							...input(dataDir),
							...(mode === "proposal-no-scope"
								? {}
								: {
										renameScope: {
											datasetVersionId: "v1",
											columns: [
												{ index: 0, name: "group" },
												{ index: 1, name: "value" },
											],
										},
									}),
						},
						() => {},
						new AbortController().signal,
					),
					{ message: ASSISTANT_WORKER_ERRORS.protocol },
					mode,
				);
			} finally {
				await driver.close();
			}
		}
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
		for (const chartScope of [null, [], false]) {
			const result = await run(
				worker,
				JSON.stringify({ ...input("fixture"), authPath: "fixture-auth.json", chartScope }),
			);
			assert.equal(result.stdout, '{"type":"error","code":"request"}\n');
		}
		const extra = await run(
			worker,
			JSON.stringify({
				...input("fixture"),
				authPath: "fixture-auth.json",
				chartScope: fauxConversationChartScope(),
				hidden: true,
			}),
		);
		assert.equal(extra.stdout, '{"type":"error","code":"request"}\n');
	});
});
