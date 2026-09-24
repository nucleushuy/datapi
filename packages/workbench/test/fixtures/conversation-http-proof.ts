import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, ImportJob } from "../../src/contracts.ts";
import type { Conversation, ConversationEvent } from "../../src/conversation-contracts.ts";
import { startWorkbench, type WorkbenchApplication } from "../../src/server.ts";
import { WorkbenchStore } from "../../src/storage.ts";
import { createFauxConversationDriver } from "./conversation-faux-driver.ts";

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(10);
	}
	throw new Error("Conversation HTTP fixture job did not settle.");
}

type Frame =
	| { type: "event"; event: ConversationEvent }
	| { type: "conversation"; conversation: Conversation }
	| { type: "error"; error: string };

async function* frames(response: Response): AsyncGenerator<Frame> {
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
	assert.ok(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			pending += decoder.decode(chunk.value, { stream: true });
			let index = pending.indexOf("\n");
			while (index >= 0) {
				const line = pending.slice(0, index);
				pending = pending.slice(index + 1);
				if (line) yield JSON.parse(line) as Frame;
				index = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		assert.equal(pending, "");
	} finally {
		reader.releaseLock();
	}
}

test("HTTP chat streams frozen references through Pi and resumes after restart", { timeout: 180_000 }, async (t) => {
	const dataDir = await mkdtemp(join(tmpdir(), "datapi-conversation-http-"));
	const store = new WorkbenchStore(dataDir);
	await store.init();
	let app: WorkbenchApplication | undefined;
	t.after(async () => {
		await app?.close();
		await store.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	const project = await store.createProject("Conversation HTTP proof");
	const job = await store.createImport(project.id, "observations.csv");
	await store.upload(
		project.id,
		job.id,
		(async function* () {
			yield Buffer.from("group,value\na,1\nb,2\n");
		})(),
	);
	const imported = await waitJob(store, project.id, job.id);
	assert.equal(imported.state, "completed", imported.error);
	assert.ok(imported.datasetId);
	const dataset = await store.getDataset(project.id, imported.datasetId);
	const profiling = await store.profile(project.id, dataset.id);
	assert.equal((await waitJob(store, project.id, profiling.id)).state, "completed");
	await store.close();

	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(() => release());
	let fixture = await createFauxConversationDriver(dataDir, { beforeResult: () => gate });
	await fixture.driver.setCredential("openai", "literal-test-not-a-real-key");
	app = await startWorkbench({ dataDir, port: 0, conversationDriver: fixture.driver, modelCatalog: fixture.catalog });
	let bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
	let headers = { "Content-Type": "application/json", "X-Workbench-Token": bootstrap.token };
	const path = `/api/projects/${project.id}/datasets/${dataset.id}/conversations`;
	const attachments = Array.from({ length: 4 }, (_, index) => ({
		name: `reference-${index}.sql`,
		mediaType: "text/plain",
		content: '"'.repeat(8192),
	}));
	const input = {
		datasetVersionId: dataset.currentVersionId,
		selectedColumns: [0, 1],
		filters: [],
		provider: "openai",
		modelId: "fixture",
		request: "Explain these references without executing them.",
		attachments,
	};
	assert.ok(Buffer.byteLength(JSON.stringify(input)) > 32 * 1024);
	const created = await fetch(`${app.url}${path}`, { method: "POST", headers, body: JSON.stringify(input) });
	assert.equal(created.status, 201, await created.clone().text());
	const conversation = (await created.json()) as Conversation;
	assert.deepEqual(
		conversation.scope.context.attachedFiles?.map((file) => file.content),
		attachments.map((file) => file.content),
	);
	assert.equal(conversation.scope.context.rowsIncluded, false);
	const excessive = await fetch(`${app.url}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ ...input, extra: "x".repeat(256 * 1024) }),
	});
	assert.equal(excessive.status, 413);
	const ordinary = await fetch(`${app.url}/api/projects`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: "x".repeat(32 * 1024) }),
	});
	assert.equal(ordinary.status, 413, "Other metadata routes retain their 32 KiB budget");

	let text = "";
	let completed: Conversation | undefined;
	let deltas = 0;
	const response = await fetch(`${app.url}${path}/${conversation.id}/messages`, {
		method: "POST",
		headers,
		body: JSON.stringify({ message: input.request }),
	});
	for await (const frame of frames(response)) {
		assert.notEqual(frame.type, "error", JSON.stringify(frame));
		if (frame.type === "event" && frame.event.type === "text") {
			assert.equal(completed, undefined);
			if (deltas === 0) {
				const running = (await (
					await fetch(`${app.url}${path}/${conversation.id}`, { headers })
				).json()) as Conversation;
				assert.equal(running.state, "running", "Delta arrives while server run is still active");
				release();
			}
			deltas++;
			text += frame.event.delta;
		} else if (frame.type === "conversation") completed = frame.conversation;
	}
	assert.ok(deltas > 1);
	assert.ok(completed);
	assert.equal(completed.state, "ready", completed.error ?? undefined);
	assert.equal(completed.messages.at(-1)?.text, text);
	assert.ok(completed.sessionFile);
	assert.deepEqual(completed.scope, conversation.scope);
	assert.equal(fixture.seen.length, 1);
	assert.ok(JSON.stringify(fixture.seen[0]).includes("reference-0.sql"));
	await app.close();

	fixture = await createFauxConversationDriver(dataDir);
	app = await startWorkbench({ dataDir, port: 0, conversationDriver: fixture.driver, modelCatalog: fixture.catalog });
	bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
	headers = { "Content-Type": "application/json", "X-Workbench-Token": bootstrap.token };
	const restored = (await (await fetch(`${app.url}${path}/${conversation.id}`, { headers })).json()) as Conversation;
	assert.deepEqual(restored.scope, completed.scope);
	assert.deepEqual(restored.messages, completed.messages);
	let resumed: Conversation | undefined;
	for await (const frame of frames(
		await fetch(`${app.url}${path}/${conversation.id}/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({ message: "Continue using the same references." }),
		}),
	)) {
		assert.notEqual(frame.type, "error", JSON.stringify(frame));
		if (frame.type === "conversation") resumed = frame.conversation;
	}
	assert.ok(resumed);
	assert.equal(resumed.state, "ready", resumed.error ?? undefined);
	assert.equal(resumed.messages.length, 4);
	assert.equal(resumed.sessionFile, completed.sessionFile);
	assert.deepEqual(resumed.scope, completed.scope);
});
