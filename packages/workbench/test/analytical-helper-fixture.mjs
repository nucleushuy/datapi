import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const emit = (value) => new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));

if (mode === "--parent") {
	// This process alone owns the helper's control pipe. Killing it must deliver EOF to the helper.
	const helper = spawn(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
		fileURLToPath(new URL("./analytical-helper.ps1", import.meta.url)),
		"-NodePath", process.execPath, "-RequestPath", process.argv[3], "-TimeoutMilliseconds", "30000",
	], { windowsHide: true, shell: false, stdio: ["pipe", "inherit", "ignore"] });
	helper.stdin.on("error", () => {});
	helper.on("error", () => process.exit(4));
	helper.on("close", (code) => process.exit(code ?? 4));
	process.stdin.resume();
	process.stdin.on("end", () => helper.stdin.end());
	await emit({ type: "helper", pid: helper.pid });
} else if (mode === "--descendant") {
	await emit({ type: "descendant", pid: process.pid });
	setInterval(() => {}, 1000);
} else if (mode === "--memory-descendant") {
	// Each process is below 1 GiB; together they exceed the job's aggregate commitment cap.
	const held = Buffer.alloc(576 * 1024 * 1024, 0x5a);
	await emit({ type: "memory-escaped", bytes: held.length });
	setInterval(() => held[0], 1000);
} else {
	const request = JSON.parse(readFileSync(mode, "utf8"));
	if (request.mode === "environment") {
		process.stderr.write("native-error-must-not-escape\n");
		await emit({ type: "environment", pid: process.pid, cwd: process.cwd(), env: process.env, stdin: readFileSync(0, "utf8") });
	} else if (request.mode === "memory") {
		await emit({ type: "ready", pid: process.pid, children: [] });
		const held = Buffer.alloc(1024 * 1024 * 1024 + 16 * 1024 * 1024, 0x5a);
		await emit({ type: "memory-escaped", bytes: held.length });
	} else if (request.mode === "aggregate-memory") {
		const held = Buffer.alloc(576 * 1024 * 1024, 0x5a);
		const child = spawn(process.execPath, [self, "--memory-descendant"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		child.stdout.pipe(process.stdout);
		child.on("error", () => process.exit(4));
		child.on("exit", () => process.exit(3));
		await emit({ type: "ready", pid: process.pid, children: [child.pid], bytes: held.length });
		setInterval(() => held[0], 1000);
	} else if (request.mode === "hang" || request.mode === "success-tree") {
		const child = spawn(process.execPath, [self, "--descendant"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		child.on("error", () => process.exit(4));
		child.stdout.once("data", () => {
			emit({ type: "ready", pid: process.pid, children: [child.pid] });
			if (request.mode === "success-tree") process.stdout.write("", () => process.exit(0));
		});
		setInterval(() => {}, 1000);
	} else {
		process.exitCode = 4;
	}
}
