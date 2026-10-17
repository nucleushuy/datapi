import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, ImportJob } from "../../src/contracts.ts";
import type { Conversation, ConversationEvent } from "../../src/conversation-contracts.ts";
import { MetadataStore } from "../../src/metadata.ts";
import type { SessionModelState } from "../../src/provider-contracts.ts";
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
	app = await startWorkbench({ dataDir, port: 0, conversationDriver: fixture.driver, providers: fixture.providers });
	let bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
	let headers = { "Content-Type": "application/json", "X-Workbench-Token": bootstrap.token };
	const path = `/api/projects/${project.id}/datasets/${dataset.id}/conversations`;
	const defaultSelection = { provider: "openai", modelId: "fixture", thinkingLevel: "off", persist: true };
	assert.equal(
		(await fetch(`${app.url}/api/chat/model`, { method: "PUT", headers, body: JSON.stringify(defaultSelection) }))
			.status,
		200,
	);
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
	assert.equal(conversation.modelState.model?.id, "fixture");
	assert.ok(conversation.sessionFile, "Selection-only sessions have a durable real Pi checkpoint");
	const selectedResponse = await fetch(`${app.url}${path}/${conversation.id}/model`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ ...defaultSelection, modelId: "fixture-second", persist: false }),
	});
	assert.equal(selectedResponse.status, 200, await selectedResponse.clone().text());
	assert.equal(((await selectedResponse.json()) as SessionModelState).model?.id, "fixture-second");
	assert.equal(fixture.seen.length, 0, "Model selection never auto-sends dataset context");
	for (const invalid of [
		{ ...defaultSelection, modelId: "missing-model" },
		{ ...defaultSelection, provider: "missing-provider" },
		{ ...defaultSelection, thinkingLevel: "max" },
		{ ...defaultSelection, persist: "true" },
		{ ...defaultSelection, extra: true },
	])
		assert.ok(
			(
				await fetch(`${app.url}${path}/${conversation.id}/model`, {
					method: "PUT",
					headers,
					body: JSON.stringify(invalid),
				})
			).status >= 400,
		);
	const selectionOnly = (await (
		await fetch(`${app.url}${path}/${conversation.id}`, { headers })
	).json()) as Conversation;
	assert.equal(selectionOnly.modelState.model?.id, "fixture-second");
	assert.deepEqual(selectionOnly.scope, conversation.scope);
	assert.deepEqual(selectionOnly.messages, []);
	const selectionCheckpoint = await readFile(selectionOnly.sessionFile!, "utf8");
	await app.close();
	fixture = await createFauxConversationDriver(dataDir, { beforeResult: () => gate });
	app = await startWorkbench({ dataDir, port: 0, conversationDriver: fixture.driver, providers: fixture.providers });
	bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
	headers = { "Content-Type": "application/json", "X-Workbench-Token": bootstrap.token };
	assert.equal(
		((await (await fetch(`${app.url}/api/chat/model`, { headers })).json()) as SessionModelState).model?.id,
		"fixture",
		"Session-only selection does not change the profile default",
	);
	const selectedAfterRestart = (await (
		await fetch(`${app.url}${path}/${conversation.id}`, { headers })
	).json()) as Conversation;
	assert.equal(
		selectedAfterRestart.modelState.model?.id,
		"fixture-second",
		"Pi restores a selection-only session before its first prompt",
	);
	assert.deepEqual(selectedAfterRestart.scope, conversation.scope);
	assert.deepEqual(selectedAfterRestart.messages, []);
	assert.equal(await readFile(selectionOnly.sessionFile!, "utf8"), selectionCheckpoint);
	assert.equal(
		conversation.title,
		input.request.trim().slice(0, 120),
		"Session title uses the approved user draft before role instructions are added to outgoing messages",
	);
	assert.equal(conversation.mode, "execute");
	assert.equal(conversation.reasoningEffort, "off");
	for (const body of [
		{ title: "" },
		{ title: "Valid", mode: "plan" },
		{ mode: "unknown" },
		{ mode: "plan", reasoningEffort: "extreme" },
		{ archivedAt: "now" },
	]) {
		const invalidResponse: Response = await fetch(`${app.url}${path}/${conversation.id}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify(body),
		});
		assert.equal(invalidResponse.status, 400);
	}
	const renamed = await fetch(`${app.url}${path}/${conversation.id}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ title: "Frozen reference analysis" }),
	});
	assert.equal(renamed.status, 200);
	assert.equal(((await renamed.json()) as Conversation).title, "Frozen reference analysis");
	const planned = await fetch(`${app.url}${path}/${conversation.id}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ mode: "plan" }),
	});
	assert.equal(planned.status, 200);
	assert.equal(((await planned.json()) as Conversation).mode, "plan");
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
				for (const action of ["duplicate", "archive"]) {
					const busyActionResponse: Response = await fetch(`${app.url}${path}/${conversation.id}/${action}`, {
						method: "POST",
						headers,
					});
					assert.equal(busyActionResponse.status, 409);
				}
				const busyPatchResponse: Response = await fetch(`${app.url}${path}/${conversation.id}`, {
					method: "PATCH",
					headers,
					body: JSON.stringify({ mode: "execute" }),
				});
				assert.equal(busyPatchResponse.status, 409);
				assert.equal(
					(
						await fetch(`${app.url}${path}/${conversation.id}/model`, {
							method: "PUT",
							headers,
							body: JSON.stringify(defaultSelection),
						})
					).status,
					409,
				);
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
	assert.equal(completed.modelState.model?.id, "fixture-second");
	assert.equal(
		completed.messages.at(-1)?.model?.id,
		"fixture-second",
		"Assistant metadata is Pi's actual dispatched model",
	);
	assert.equal(fixture.seen.length, 1);
	assert.ok(JSON.stringify(fixture.seen[0]).includes("reference-0.sql"));
	assert.deepEqual(fixture.seen[0].tools ?? [], [], "Plan mode exposes no proposal or execution tools");
	const sourceSession = await readFile(completed.sessionFile, "utf8");
	const duplicated = await fetch(`${app.url}${path}/${conversation.id}/duplicate`, { method: "POST", headers });
	assert.equal(duplicated.status, 201, await duplicated.clone().text());
	const copy = (await duplicated.json()) as Conversation;
	assert.notEqual(copy.id, conversation.id);
	assert.notEqual(copy.sessionFile, completed.sessionFile);
	assert.deepEqual(copy.scope, completed.scope);
	assert.deepEqual(copy.messages, completed.messages);
	assert.ok(copy.sessionFile);
	const copySession = await readFile(copy.sessionFile, "utf8");
	assert.deepEqual(copySession.trim().split("\n").slice(1), sourceSession.trim().split("\n").slice(1));
	const archive = await fetch(`${app.url}${path}/${copy.id}/archive`, { method: "POST", headers });
	assert.equal(archive.status, 200);
	const listed = (await (await fetch(`${app.url}${path}`, { headers })).json()) as Conversation[];
	assert.equal(
		listed.some(({ id }) => id === copy.id),
		false,
	);
	assert.equal(
		(await fetch(`${app.url}${path}/${copy.id}`, { headers })).status,
		200,
		"Archived audit remains readable",
	);
	const persistResponse = await fetch(`${app.url}${path}/${conversation.id}/model`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ ...defaultSelection, modelId: "fixture-second" }),
	});
	assert.equal(persistResponse.status, 200);
	await app.close();
	// A pre-upgrade record lacks modelState; the Pi JSONL remains the restoration authority.
	const metadata = new MetadataStore(join(dataDir, "workbench.sqlite"));
	const persistedConversation = metadata.conversation(project.id, dataset.id, conversation.id)!;
	delete (persistedConversation as Partial<Conversation>).modelState;
	metadata.putConversation(persistedConversation);
	metadata.close();

	fixture = await createFauxConversationDriver(dataDir);
	app = await startWorkbench({ dataDir, port: 0, conversationDriver: fixture.driver, providers: fixture.providers });
	bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
	headers = { "Content-Type": "application/json", "X-Workbench-Token": bootstrap.token };
	assert.equal(
		((await (await fetch(`${app.url}/api/chat/model`, { headers })).json()) as SessionModelState).model?.id,
		"fixture-second",
		"Explicit default persistence survives restart",
	);
	const restored = (await (await fetch(`${app.url}${path}/${conversation.id}`, { headers })).json()) as Conversation;
	assert.deepEqual(restored.scope, completed.scope);
	assert.deepEqual(restored.messages, completed.messages);
	assert.equal(restored.mode, "plan");
	assert.equal(restored.title, "Frozen reference analysis");
	assert.equal(
		restored.modelState.model?.id,
		"fixture-second",
		"Legacy DTO hydrates from the real Pi session, not frozen original scope",
	);
	assert.equal(restored.scope.modelId, "fixture");
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
	assert.notEqual(resumed.sessionFile, completed.sessionFile);
	assert.deepEqual(resumed.scope, completed.scope);
	assert.equal(
		await readFile(copy.sessionFile, "utf8"),
		copySession,
		"Following up the source cannot mutate its independent duplicate",
	);
	assert.equal(await readFile(completed.sessionFile, "utf8"), sourceSession);
	const archived = (await (await fetch(`${app.url}${path}/${copy.id}`, { headers })).json()) as Conversation;
	assert.ok(archived.archivedAt);
	assert.deepEqual(archived.messages, copy.messages);
});
