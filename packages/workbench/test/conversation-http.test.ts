import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("HTTP Pi streaming, disclosure budgets and restart proof", { timeout: 200_000 }, async () => {
	const env: NodeJS.ProcessEnv = {
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
	};
	for (const name of ["SystemRoot", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name];
	const child = spawn(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			"--test",
			fileURLToPath(new URL("./fixtures/conversation-http-proof.ts", import.meta.url)),
		],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			env,
			windowsHide: true,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	let overflow = false;
	const collect = (chunk: Buffer) => {
		if (output.length + chunk.length > 1024 * 1024) {
			overflow = true;
			child.kill("SIGKILL");
		} else output += chunk.toString("utf8");
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	// A real child can hang independently of the test clock; bound its lifetime without delaying successful runs.
	const watchdog = setTimeout(() => child.kill("SIGKILL"), 190_000);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(overflow, false, "HTTP proof output exceeded its bound");
		assert.equal(code, 0, output);
		assert.match(output, /# pass 1\b/);
	} finally {
		clearTimeout(watchdog);
	}
});
