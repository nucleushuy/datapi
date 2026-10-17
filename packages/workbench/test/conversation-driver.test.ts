import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ASSISTANT_REQUEST_BYTES, ASSISTANT_WORKER_ERRORS } from "../src/assistant-driver.ts";
import { PiConversationDriver } from "../src/conversation-driver.ts";
import { ProviderService } from "../src/provider-service.ts";
import { createFauxConversationRuntime, snapshotConversationContext } from "./fixtures/conversation-faux-driver.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const proof = fileURLToPath(new URL("./fixtures/conversation-sdk-proof.ts", import.meta.url));
function input(dataDir: string) {
	return {
		conversationId: "retained-session",
		provider: "openai",
		modelId: "fixture",
		sessionFile: null,
		sessionDir: join(dataDir, "sessions"),
		system: `Read-only approved conversation.\nCurrent working directory: ${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n`,
		user: "Explain the frozen context.",
	};
}

describe("Pi-native retained conversation runtime", { concurrency: false, timeout: 240_000 }, () => {
	it("proves SDK disclosure, proposal safety, limits, selection, routing, persistence and failure isolation offline", async () => {
		const env: NodeJS.ProcessEnv = {
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			TSX_DISABLE_CACHE: "1",
			TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.runtime.json", import.meta.url)),
		};
		for (const name of ["SystemRoot", "TEMP", "TMP"])
			if (process.env[name] !== undefined) env[name] = process.env[name];
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), proof], {
			cwd: root,
			env,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const parts: Buffer[] = [];
		const errors: Buffer[] = [];
		child.stdout.on("data", (part: Buffer) => parts.push(part));
		child.stderr.on("data", (part: Buffer) => errors.push(part));
		const timeout = setTimeout(() => child.kill(), 210_000);
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
			assert.equal(Buffer.concat(parts).toString("utf8"), "CONVERSATION_SDK_PROOF_OK\n");
		} finally {
			clearTimeout(timeout);
		}
	});

	it("discards a successful but uncommitted turn on the same retained session", async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-retained-"));
		const { runtime, faux } = await createFauxConversationRuntime();
		const providers = await ProviderService.create(directory, { runtime });
		const driver = new PiConversationDriver(providers);
		t.after(async () => {
			await driver.close();
			await providers.close();
			await rm(directory, { recursive: true, force: true });
		});
		faux.setResponses([
			fauxAssistantMessage("Committed response"),
			fauxAssistantMessage("Unpublished response"),
			(raw) => {
				const context = snapshotConversationContext(raw);
				assert.deepEqual(
					context.messages.map((message) => message.role),
					["user", "assistant", "user"],
				);
				assert.equal(JSON.stringify(context.messages).includes("Unpublished"), false);
				return fauxAssistantMessage("Only committed history");
			},
		]);
		const first = await driver.chat(input(directory), () => {}, new AbortController().signal);
		const original = await readFile(first.sessionFile, "utf8");
		const unpublished = await driver.chat(
			{ ...input(directory), sessionFile: first.sessionFile, user: "Unpublished user" },
			() => {},
			new AbortController().signal,
		);
		assert.notEqual(unpublished.sessionFile, first.sessionFile);
		const next = await driver.chat(
			{ ...input(directory), sessionFile: first.sessionFile, user: "Published followup" },
			() => {},
			new AbortController().signal,
		);
		assert.equal(next.text, "Only committed history");
		assert.equal(await readFile(first.sessionFile, "utf8"), original);
	});

	it("rejects invalid requests before calls and cancels active work on close", async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-close-"));
		const { runtime, faux } = await createFauxConversationRuntime();
		const providers = await ProviderService.create(directory, { runtime });
		const driver = new PiConversationDriver(providers);
		t.after(async () => {
			await driver.close();
			await providers.close();
			await rm(directory, { recursive: true, force: true });
		});
		await assert.rejects(
			driver.chat(
				{ ...input(directory), user: "x".repeat(ASSISTANT_REQUEST_BYTES) },
				() => {},
				new AbortController().signal,
			),
			{ message: ASSISTANT_WORKER_ERRORS.request },
		);
		await assert.rejects(
			driver.chat(input(directory), () => {}, AbortSignal.abort()),
			{ message: ASSISTANT_WORKER_ERRORS.cancelled },
		);
		assert.equal(faux.state.callCount, 0);
		faux.setResponses([fauxAssistantMessage("A long response to cancel. ".repeat(40))]);
		let closing: Promise<void> | undefined;
		let deltas = 0;
		await assert.rejects(
			driver.chat(
				input(directory),
				(event) => {
					if (event.type !== "text") return;
					deltas++;
					closing = driver.close();
				},
				new AbortController().signal,
			),
			{ message: ASSISTANT_WORKER_ERRORS.cancelled },
		);
		await closing;
		assert.equal(deltas, 1);
		await assert.rejects(driver.draftModelState(), { status: 503 });
	});
});
