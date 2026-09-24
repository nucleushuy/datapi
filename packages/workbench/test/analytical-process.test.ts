import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runAnalytical } from "../src/analytical-process.ts";

const windows = process.platform === "win32" && process.arch === "x64";
const helperPath = fileURLToPath(new URL("./analytical-helper.ps1", import.meta.url));
const fixturePath = fileURLToPath(new URL("./analytical-helper-fixture.mjs", import.meta.url));
const powershell = join(
	process.env.SystemRoot ?? "C:\\Windows",
	"System32",
	"WindowsPowerShell",
	"v1.0",
	"powershell.exe",
);

type Message = {
	type: string;
	pid?: number;
	children?: number[];
	bytes?: number;
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
};
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function until(check: () => boolean, message: string, timeout = 15_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		assert.ok(Date.now() < deadline, message);
		await delay(25);
	}
}

async function directory(context: TestContext): Promise<string> {
	// Spaces, quotes and Unicode exercise CreateProcess argument quoting without any shell interpolation.
	const root = await mkdtemp(join(tmpdir(), "pi worker ' 雪 "));
	context.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	return root;
}

async function launch(
	context: TestContext,
	mode: string,
	options: {
		timeout?: number;
		parent?: boolean;
		env?: NodeJS.ProcessEnv;
		nodePath?: string;
		oversized?: boolean;
	} = {},
): Promise<{
	child: ChildProcess;
	root: string;
	messages: Message[];
	exit: Promise<Exit>;
	ready: () => Promise<Message>;
	stderr: () => string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi worker ' 雪 "));
	const request = join(root, "request ' 雪.json");
	await writeFile(request, options.oversized ? " ".repeat(16 * 1024 + 1) : JSON.stringify({ mode }));
	const child = options.parent
		? spawn(process.execPath, [fixturePath, "--parent", request], { windowsHide: true, shell: false, stdio: "pipe" })
		: spawn(
				powershell,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					helperPath,
					"-NodePath",
					options.nodePath ?? process.execPath,
					"-RequestPath",
					request,
					"-TimeoutMilliseconds",
					String(options.timeout ?? 30_000),
				],
				{ windowsHide: true, shell: false, stdio: "pipe", env: options.env ?? process.env },
			);
	const messages: Message[] = [];
	let pending = "";
	let stderr = "";
	let malformed = false;
	let closed = false;
	let received = 0;
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		received += Buffer.byteLength(chunk);
		if (received > 64 * 1024) {
			malformed = true;
			child.stdin?.end();
			return;
		}
		pending += chunk;
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			try {
				messages.push(JSON.parse(pending.slice(0, newline)) as Message);
			} catch {
				malformed = true;
			}
			pending = pending.slice(newline + 1);
		}
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(0, 64 * 1024);
	});
	child.stdin?.on("error", () => {});
	const exit = new Promise<Exit>((resolve) => {
		let error: Error | undefined;
		child.once("error", (value) => {
			error = value;
		});
		child.once("close", (code, signal) => {
			closed = true;
			resolve({ code, signal, error });
		});
	});
	context.after(async () => {
		child.stdin?.end();
		if (!closed) {
			try {
				await until(() => closed, "Helper did not stop on cleanup EOF", 6000);
			} catch {
				child.kill();
			}
		}
		// Also clean known fixture PIDs on assertion failure; production behavior is asserted before this hook.
		for (const message of messages) {
			for (const pid of [...(message.children ?? []), ...(message.pid ? [message.pid] : [])]) {
				if (alive(pid)) process.kill(pid);
			}
		}
		if (!closed) await until(() => closed, "Helper did not close after cleanup", 6000);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	return {
		child,
		root,
		messages,
		exit,
		stderr: () => stderr,
		ready: async () => {
			await until(
				() => messages.some((message) => message.type === "ready") || closed || malformed,
				"Fixed analytical fixture did not become ready",
			);
			assert.equal(malformed, false, "Helper stdout must contain only fixture JSON");
			const ready = messages.find((message) => message.type === "ready");
			assert.ok(ready, "Helper exited before fixture readiness");
			return ready;
		},
	};
}

function assertTreeStopped(ready: Message): void {
	assert.ok(ready.pid);
	for (const pid of [ready.pid, ...(ready.children ?? [])])
		assert.equal(alive(pid), false, `Fixture process ${pid} survived helper completion`);
}

describe("Windows analytical JobObject helper", { skip: !windows, concurrency: false, timeout: 60_000 }, () => {
	it("sanitizes the native worker environment and gives it NUL stdin/stderr", async (context) => {
		const helper = await launch(context, "environment", {
			env: {
				...process.env,
				NODE_OPTIONS: "--require=missing-secret-module",
				NODE_PATH: "secret-node-modules",
				OPENAI_API_KEY: "secret-api-key",
				AWS_SECRET_ACCESS_KEY: "secret-cloud-key",
				HTTP_PROXY: "http://secret-proxy.invalid",
				PI_HELPER_SECRET: "secret-parent-value",
			},
		});
		assert.deepEqual(await helper.exit, { code: 0, signal: null, error: undefined });
		assert.equal(helper.stderr(), "");
		assert.equal(helper.messages.length, 1);
		const message = helper.messages[0];
		assert.equal(message.type, "environment");
		assert.equal(message.stdin, "");
		assert.equal(normalize(message.cwd!), normalize(helper.root));
		assert.ok(message.env);
		const env = Object.fromEntries(Object.entries(message.env).map(([key, value]) => [key.toUpperCase(), value]));
		assert.deepEqual(
			Object.keys(env).sort(),
			["APPDATA", "HOME", "LOCALAPPDATA", "PATH", "SYSTEMROOT", "TEMP", "TMP", "TZ", "USERPROFILE", "WINDIR"].sort(),
		);
		for (const key of ["APPDATA", "HOME", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"])
			assert.equal(normalize(env[key]), normalize(helper.root));
		assert.equal(normalize(env.PATH), normalize(join(env.SYSTEMROOT, "System32")));
		assert.equal(env.WINDIR, env.SYSTEMROOT);
		assert.equal(env.TZ, "UTC");
	});

	it("enforces the real 1 GiB process commitment limit", async (context) => {
		const helper = await launch(context, "memory");
		const ready = await helper.ready();
		const code = (await helper.exit).code;
		assert.ok(code === 1 || code === 123, `Memory exhaustion must fail the worker, not time out: ${code}`);
		assert.equal(
			helper.messages.some((message) => message.type === "memory-escaped"),
			false,
		);
		assertTreeStopped(ready);
	});

	it("enforces the real 1 GiB aggregate job commitment limit across descendants", async (context) => {
		const helper = await launch(context, "aggregate-memory");
		const ready = await helper.ready();
		assert.equal((await helper.exit).code, 123);
		assert.equal(
			helper.messages.some((message) => message.type === "memory-escaped"),
			false,
		);
		assertTreeStopped(ready);
	});

	it("times out and waits until the whole process tree is gone", async (context) => {
		const helper = await launch(context, "hang", { timeout: 5000 });
		const ready = await helper.ready();
		assert.equal((await helper.exit).code, 121);
		assertTreeStopped(ready);
	});

	it("cancels on control-pipe EOF and waits for descendant termination", async (context) => {
		const helper = await launch(context, "hang");
		const ready = await helper.ready();
		helper.child.stdin?.end();
		assert.equal((await helper.exit).code, 122);
		assertTreeStopped(ready);
	});

	it("kills the worker tree when the actual control-pipe parent dies", async (context) => {
		const parent = await launch(context, "hang", { parent: true });
		const ready = await parent.ready();
		const helperPid = parent.messages.find((message) => message.type === "helper")?.pid;
		assert.ok(helperPid);
		assert.equal(parent.child.kill(), true);
		await until(
			() => !alive(helperPid) && !alive(ready.pid!) && (ready.children ?? []).every((pid) => !alive(pid)),
			"Helper or descendants survived their control-pipe parent's death",
		);
		await parent.exit;
		assertTreeStopped(ready);
	});

	it("kills descendants when the launcher is forcibly terminated", async (context) => {
		const helper = await launch(context, "hang");
		const ready = await helper.ready();
		assert.equal(helper.child.kill(), true);
		await until(
			() => !alive(ready.pid!) && (ready.children ?? []).every((pid) => !alive(pid)),
			"KILL_ON_JOB_CLOSE did not terminate descendants",
		);
		await helper.exit;
		assertTreeStopped(ready);
	});

	it("removes surviving descendants even after a successful worker exit", async (context) => {
		const helper = await launch(context, "success-tree");
		const ready = await helper.ready();
		assert.equal((await helper.exit).code, 0);
		assertTreeStopped(ready);
	});

	it("fails closed without executing the worker if the executable is unavailable", async (context) => {
		const root = await directory(context);
		const helper = await launch(context, "environment", { nodePath: join(root, "missing-node.exe") });
		assert.equal((await helper.exit).code, 120);
		assert.deepEqual(helper.messages, []);
		assert.equal(helper.stderr(), "");
	});

	it("fails closed on an oversized control request before starting the worker", async (context) => {
		const helper = await launch(context, "environment", { oversized: true });
		assert.equal((await helper.exit).code, 120);
		assert.deepEqual(helper.messages, []);
	});
});

describe("analytical process boundary", () => {
	it("honors pre-aborted requests without starting a process", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runAnalytical(
				{ kind: "preview", artifactPath: "", tempPath: "", offset: 0, limit: 1, total: 0 },
				undefined,
				controller.signal,
			),
			{ message: "Dataset processing was cancelled." },
		);
	});

	it("rejects invalid requests before starting the helper", { skip: !windows }, async () => {
		await assert.rejects(
			runAnalytical({ kind: "preview", artifactPath: tmpdir(), tempPath: tmpdir(), offset: -1, limit: 1, total: 0 }),
			{ message: "Analytical worker request is invalid." },
		);
	});
});
