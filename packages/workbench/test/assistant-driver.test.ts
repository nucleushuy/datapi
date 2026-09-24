import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSISTANT_CONTEXT_BYTES, ASSISTANT_OUTPUT_BYTES, type AssistantProgress } from "../src/assistant-contracts.ts";
import {
	ASSISTANT_CATALOG_BYTES,
	ASSISTANT_PROVIDERS,
	ASSISTANT_REQUEST_BYTES,
	ASSISTANT_WORKER_ERRORS,
	AssistantResponseDecoder,
	isAssistantApiKey,
	PiAssistantDriver,
	parseAssistantWorkerRequest,
} from "../src/assistant-driver.ts";
import { PiConversationDriver } from "../src/conversation-driver.ts";

const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };
const payload = {
	system: `Approved system text.\nCurrent working directory: ${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n`,
	user: "/skill:not-a-real-command {{literal user data}}",
};
const workerPath = fileURLToPath(new URL("../src/assistant-sdk-worker.ts", import.meta.url));
const sdkProofPath = fileURLToPath(new URL("./fixtures/assistant-sdk-proof.ts", import.meta.url));
function frame(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`);
}
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		TSX_DISABLE_CACHE: "1",
		TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
	};
	for (const name of ["SystemRoot", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name];
	return env;
}
async function launch(path: string, input: Buffer | string): Promise<{ code: number | null; stdout: string }> {
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--max-old-space-size=256", path], {
		cwd: fileURLToPath(new URL("../../../", import.meta.url)),
		env: childEnv(),
		windowsHide: true,
		shell: false,
		stdio: ["pipe", "pipe", "ignore"],
	});
	let bytes = 0;
	const parts: Buffer[] = [];
	child.stdout.on("data", (part: Buffer) => {
		bytes += part.length;
		if (bytes > ASSISTANT_CATALOG_BYTES) child.kill("SIGKILL");
		else parts.push(part);
	});
	child.stdin.on("error", () => {});
	// Real-process watchdog only: completion is awaited through close, never a guessed sleep.
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	try {
		const result = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, stdout: Buffer.concat(parts).toString("utf8") }));
		});
		child.stdin.end(input);
		return await result;
	} finally {
		clearTimeout(timer);
	}
}

describe("assistant request and response boundaries", () => {
	it("accepts literal keys but rejects commands, substitutions, controls, and invalid bounds", () => {
		for (const key of ["12345678", `sk-${"x".repeat(8189)}`]) assert.equal(isAssistantApiKey(key), true);
		for (const key of [
			null,
			{},
			"short",
			"x".repeat(8193),
			"!execute-command",
			`\${API_KEY}`,
			"$API_KEY",
			"$(command)",
			"`command`",
			" leading-key",
			"trailing-key ",
			"key\nsecret",
			"key\u0000secret",
			"key\u0085secret",
		])
			assert.equal(isAssistantApiKey(key), false);
	});
	it("enforces the UTF-8 request boundary and rejects extra credentials or hidden fields", () => {
		const input = {
			operation: "generate",
			credentials: { openai: "literal-key" },
			provider: "openai",
			modelId: "fixture",
			payload: { system: "s", user: "x".repeat(ASSISTANT_CONTEXT_BYTES - 1) },
		};
		assert.deepEqual(parseAssistantWorkerRequest(input), input);
		for (const invalid of [
			{ ...input, payload: { system: "s", user: `${input.payload.user}x` } },
			{ ...input, payload: { system: "s", user: "雪".repeat(ASSISTANT_CONTEXT_BYTES / 3) } },
			{ ...input, credentials: { ...input.credentials, google: "other-key" } },
			{ ...input, provider: "google-vertex" },
			{ ...input, tools: [] },
			{ ...input, payload: { ...input.payload, history: [] } },
			{ ...input, credentials: JSON.parse('{"__proto__":"literal-key"}') },
		])
			assert.throws(() => parseAssistantWorkerRequest(invalid), { message: ASSISTANT_WORKER_ERRORS.request });
	});
	it("decodes UTF-8 across every byte boundary without exposing raw text in progress", () => {
		const progress: AssistantProgress[] = [];
		const decoder = new AssistantResponseDecoder("generate", (event) => progress.push(event));
		const text = "雪 𝛼 approved";
		const output = Buffer.concat([
			frame({ type: "progress", receivedCharacters: 1 }),
			frame({ type: "usage", usage }),
			frame({ type: "result", text, usage }),
		]);
		for (const byte of output) decoder.push(Buffer.from([byte]));
		assert.deepEqual(decoder.finish(), { text, usage });
		assert.deepEqual(progress, [
			{ type: "progress", receivedCharacters: 1 },
			{ type: "usage", usage },
		]);
	});
	it("allows exactly bounded raw output including escaped control characters", () => {
		const text = "\u0000".repeat(ASSISTANT_OUTPUT_BYTES);
		const decoder = new AssistantResponseDecoder("generate");
		decoder.push(frame({ type: "result", text, usage }));
		assert.deepEqual(decoder.finish(), { text, usage });
	});
	it("rejects malformed, excessive, regressing, foreign, and post-terminal frames", () => {
		for (const invalid of [
			Buffer.from("\n"),
			Buffer.from("not-json\n"),
			Buffer.from([0xff, 10]),
			frame({ type: "result", text: "x".repeat(ASSISTANT_OUTPUT_BYTES + 1), usage }),
			frame({ type: "result", text: "x", usage: { ...usage, input: -1 } }),
			frame({ type: "result", text: "x", usage: { ...usage, output: 1.5 } }),
			frame({ type: "error", code: "raw-secret-error" }),
			frame({ type: "error", code: "provider", message: "secret" }),
			frame({ type: "models", models: [] }),
			Buffer.concat([
				frame({ type: "progress", receivedCharacters: 5 }),
				frame({ type: "progress", receivedCharacters: 4 }),
			]),
			Buffer.concat([frame({ type: "result", text: "x", usage }), frame({ type: "usage", usage })]),
		])
			assert.throws(() => new AssistantResponseDecoder("generate").push(invalid), {
				message: ASSISTANT_WORKER_ERRORS.protocol,
			});
		const incomplete = new AssistantResponseDecoder("generate");
		incomplete.push(Buffer.from('{"type":"result"'));
		assert.throws(() => incomplete.finish(), { message: ASSISTANT_WORKER_ERRORS.protocol });
		assert.throws(() => new AssistantResponseDecoder("models").push(Buffer.alloc(ASSISTANT_CATALOG_BYTES + 1)), {
			message: ASSISTANT_WORKER_ERRORS.protocol,
		});
		const flooding = new AssistantResponseDecoder("generate");
		assert.throws(
			() => {
				for (let i = 0; i < 3000; i++) flooding.push(frame({ type: "progress", receivedCharacters: 0 }));
			},
			{ message: ASSISTANT_WORKER_ERRORS.protocol },
		);
	});
	it("rejects duplicate and credential-bearing catalog records", () => {
		const model = { provider: "openai", id: "fixture", name: "Fixture", contextWindow: 128000, configured: false };
		for (const models of [
			[model, model],
			[{ ...model, apiKey: "secret" }],
			[{ ...model, provider: "amazon-bedrock" }],
			[{ ...model, contextWindow: 0 }],
		])
			assert.throws(() => new AssistantResponseDecoder("models").push(frame({ type: "models", models })), {
				message: ASSISTANT_WORKER_ERRORS.protocol,
			});
		const failed = new AssistantResponseDecoder("generate");
		failed.push(frame({ type: "error", code: "provider" }));
		assert.throws(() => failed.finish(), { message: ASSISTANT_WORKER_ERRORS.provider });
	});
});

describe("actual isolated assistant runtime", { concurrency: false, timeout: 180_000 }, () => {
	it("lists the offline built-in catalog with per-instance memory-only configuration", async () => {
		const driver = new PiAssistantDriver();
		const fresh = new PiAssistantDriver();
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "ambient-key-must-not-be-used";
		try {
			const [unconfigured, concurrent] = await Promise.all([driver.models(), driver.models()]);
			assert.deepEqual(concurrent, unconfigured);
			assert.ok(unconfigured.models.length > 0);
			assert.ok(unconfigured.models.every((model) => !model.configured && ASSISTANT_PROVIDERS.has(model.provider)));
			assert.deepEqual(new Set(unconfigured.models.map((model) => model.provider)), ASSISTANT_PROVIDERS);
			await driver.setCredential("openai", "literal-test-not-a-real-key");
			const configured = await driver.models();
			assert.ok(configured.models.filter((model) => model.provider === "openai").every((model) => model.configured));
			assert.ok(
				configured.models.filter((model) => model.provider !== "openai").every((model) => !model.configured),
			);
			configured.models[0].name = "caller mutation";
			assert.notEqual((await driver.models()).models[0].name, "caller mutation");
			assert.ok(!JSON.stringify(configured).includes("literal-test-not-a-real-key"));
			assert.match(configured.guidance, /Pi stores/);
			assert.ok((await fresh.models()).models.every((model) => !model.configured));
			await driver.deleteCredential("openai");
			assert.ok((await driver.models()).models.every((model) => !model.configured));
			await assert.rejects(
				driver.generate(
					{ provider: "openai", modelId: "fixture", payload },
					() => {},
					new AbortController().signal,
				),
				{ message: ASSISTANT_WORKER_ERRORS.credentials },
			);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
			await driver.close();
			await fresh.close();
		}
	});

	it("persists provider authorization through Pi credential storage", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "pi-conversation-auth-"));
		context.after(() => rm(root, { recursive: true, force: true }));
		const first = new PiConversationDriver(root);
		const second = new PiConversationDriver(root);
		try {
			await first.setCredential("openai", "literal-test-not-a-real-key");
			assert.deepEqual(await first.authorizedProviders(), ["openai"]);
			assert.deepEqual(await second.authorizedProviders(), ["openai"]);
			await second.deleteCredential("openai");
			assert.deepEqual(await first.authorizedProviders(), []);
		} finally {
			await first.close();
			await second.close();
		}
	});
	it("cancels pre-start and active child work and closes outstanding catalog workers", async () => {
		const driver = new PiAssistantDriver();
		const pre = AbortSignal.abort();
		await assert.rejects(driver.models(pre), { message: ASSISTANT_WORKER_ERRORS.cancelled });
		const controller = new AbortController();
		const active = driver.models(controller.signal);
		controller.abort();
		await assert.rejects(active, { message: ASSISTANT_WORKER_ERRORS.cancelled });
		const closing = driver.models();
		const rejected = assert.rejects(closing, { message: ASSISTANT_WORKER_ERRORS.cancelled });
		await driver.close();
		await rejected;
		await assert.rejects(driver.models(), { status: 503 });
		await assert.rejects(driver.setCredential("openai", "literal-key"), { status: 503 });
	});
	it("rejects hostile credentials without executing them or echoing their contents", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "pi-assistant-key-"));
		context.after(() => rm(root, { recursive: true, force: true }));
		const marker = join(root, "executed");
		const key = `!node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')"`;
		const driver = new PiAssistantDriver();
		try {
			await assert.rejects(
				driver.setCredential("openai", key),
				(error: unknown) => error instanceof Error && !error.message.includes(key),
			);
			const response = await launch(
				workerPath,
				JSON.stringify({ operation: "models", credentials: { openai: key } }),
			);
			assert.equal(response.code, 0);
			assert.equal(response.stdout, '{"type":"error","code":"request"}\n');
			await assert.rejects(access(marker), { code: "ENOENT" });
		} finally {
			await driver.close();
		}
	});
	it("rejects invalid UTF-8 and oversized child requests before model generation", async () => {
		for (const input of [
			Buffer.from([0xff]),
			Buffer.alloc(ASSISTANT_REQUEST_BYTES + 1, 32),
			Buffer.from('{"operation":"inspect","credentials":{}}'),
		]) {
			const response = await launch(workerPath, input);
			assert.equal(response.code, 0);
			assert.equal(response.stdout, '{"type":"error","code":"request"}\n');
		}
		const missing = await launch(
			workerPath,
			JSON.stringify({ operation: "generate", credentials: {}, provider: "openai", modelId: "fixture", payload }),
		);
		assert.equal(missing.stdout, '{"type":"error","code":"credentials"}\n');
	});
	it("runs real public SDK sessions against only the deterministic faux provider", async () => {
		const result = await launch(sdkProofPath, "");
		assert.equal(result.code, 0, result.stdout);
		assert.equal(result.stdout, "SDK_PROOF_OK\n");
	});
});
