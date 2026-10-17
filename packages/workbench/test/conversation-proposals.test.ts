import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantContext } from "../src/assistant-contracts.ts";
import type { Conversation, RenameProposal, RenameProposalInput } from "../src/conversation-contracts.ts";
import { ConversationService } from "../src/conversation-service.ts";
import { MetadataStore } from "../src/metadata.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";
import { createFauxConversationDriver } from "./fixtures/conversation-faux-driver.ts";

function status(code: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === code;
}

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "workbench-proposals-"));
	const state = { root, store: new WorkbenchStore(root) };
	context.after(async () => {
		await state.store.close();
		await rm(root, { recursive: true, force: true });
	});
	await state.store.init();
	const project = await state.store.createProject("Column renames");
	const job = await state.store.createImport(project.id, "source.csv");
	await state.store.upload(
		project.id,
		job.id,
		(async function* () {
			yield Buffer.from("category,value,private\nA,1,first-secret\nB,2,second-secret\n");
		})(),
	);
	let completed = state.store.getJob(project.id, job.id);
	for (let attempt = 0; attempt < 12000 && ["uploading", "processing"].includes(completed.state); attempt++) {
		await delay(10);
		completed = state.store.getJob(project.id, job.id);
	}
	assert.equal(completed.state, "completed", completed.error);
	assert.ok(completed.datasetId);
	const dataset = await state.store.getDataset(project.id, completed.datasetId);
	const facts = dataset.versions.find((version) => version.id === dataset.currentVersionId)!.facts!;
	const disclosure: AssistantContext = {
		version: 1,
		project: { id: project.id, name: project.name, description: project.description },
		dataset: {
			id: dataset.id,
			name: dataset.name,
			versionId: dataset.currentVersionId,
			artifactHash: facts.artifactSha256,
			rowCount: dataset.rowCount,
			columnCount: dataset.columnCount,
		},
		schema: [dataset.schema[0]],
		selectedColumns: [0],
		filters: [],
		evidence: [],
		artifacts: [],
		limitations: [],
		rowsIncluded: false,
	};
	const now = new Date().toISOString();
	const conversation: Conversation = {
		id: randomUUID(),
		projectId: project.id,
		datasetId: dataset.id,
		createdAt: now,
		updatedAt: now,
		title: "Rename category",
		archivedAt: null,
		state: "ready",
		sessionFile: null,
		modelState: { model: null, thinkingLevel: "off", routedModel: null },
		scope: {
			version: 1,
			projectId: project.id,
			datasetId: dataset.id,
			datasetVersionId: dataset.currentVersionId,
			provider: "openai",
			modelId: "fixture",
			context: disclosure,
			contextHash: createHash("sha256").update(JSON.stringify(disclosure)).digest("hex"),
			grantedAt: now,
		},
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		error: null,
	};
	await state.store.putConversation(conversation);
	return { state, projectId: project.id, dataset, conversation };
}

async function propose(store: WorkbenchStore, conversation: Conversation, name = "segment"): Promise<RenameProposal> {
	const current = await store.conversation(conversation.projectId, conversation.datasetId, conversation.id);
	current.state = "running";
	await store.putConversation(current);
	current.state = "ready";
	const input: RenameProposalInput = {
		toolCallId: randomUUID(),
		datasetVersionId: current.scope.datasetVersionId,
		column: 0,
		name,
	};
	await store.putConversation(current, [input]);
	return (await store.renameProposals(current.projectId, current.datasetId, current.id)).find(
		(proposal) => proposal.toolCallId === input.toolCallId,
	)!;
}

async function reopen(state: { root: string; store: WorkbenchStore }): Promise<void> {
	await state.store.close();
	state.store = new WorkbenchStore(state.root);
	await state.store.init();
}

function approval(proposal: RenameProposal) {
	assert.ok(proposal.preview);
	return { previewId: proposal.preview.id, approved: true };
}

test(
	"exact approval, safe rejection and applied audit survive restart and undo",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const originalPath = join(
			state.root,
			dataset.versions.find((version) => version.id === dataset.currentVersionId)!.storageLocation,
		);
		const original = await readFile(originalPath);
		const proposed = await propose(state.store, conversation);
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposed.id, {
				previewId: randomUUID(),
				approved: true,
			}),
			status(409),
		);
		assert.equal(
			(await state.store.renameProposal(projectId, dataset.id, conversation.id, proposed.id)).state,
			"proposed",
		);
		assert.equal(
			(await state.store.rejectRenameProposal(projectId, dataset.id, conversation.id, proposed.id)).state,
			"rejected",
		);
		await assert.rejects(
			state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposed.id),
			status(409),
		);
		const second = await propose(state.store, conversation);
		const preview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, second.id);
		assert.ok(preview.preview);
		assert.deepEqual(Object.keys(preview.preview).sort(), [
			"affectedRows",
			"expiresAt",
			"id",
			"inputRows",
			"outputRows",
			"sql",
		]);
		assert.equal(preview.preview.inputRows, 2);
		assert.equal(JSON.stringify(preview).includes("first-secret"), false);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		await state.store.rejectRenameProposal(projectId, dataset.id, conversation.id, second.id);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		const third = await propose(state.store, conversation);
		const ready = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, third.id);
		const planning = await state.store.conversation(projectId, dataset.id, conversation.id);
		planning.mode = "plan";
		await state.store.putConversation(planning);
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, third.id, approval(ready)),
			/Plan mode cannot apply/,
		);
		assert.equal(
			(await state.store.renameProposal(projectId, dataset.id, conversation.id, third.id)).state,
			"previewed",
		);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		planning.mode = "execute";
		await state.store.putConversation(planning);
		for (const body of [
			{ previewId: ready.preview!.id },
			{ ...approval(ready), approved: false },
			{ ...approval(ready), name: "surprise" },
		])
			await assert.rejects(
				state.store.applyRenameProposal(projectId, dataset.id, conversation.id, third.id, body),
				status(400),
			);
		await assert.rejects(state.store.applyTransform(projectId, dataset.id, approval(ready)), status(409));
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, third.id, {
				previewId: randomUUID(),
				approved: true,
			}),
			status(409),
		);
		const applied = await state.store.applyRenameProposal(
			projectId,
			dataset.id,
			conversation.id,
			third.id,
			approval(ready),
		);
		assert.equal(applied.dataset.schema[0].name, "segment");
		assert.equal(applied.dataset.rowCount, dataset.rowCount);
		assert.equal(applied.proposal.outputVersionId, applied.dataset.currentVersionId);
		assert.deepEqual(
			applied.proposal.audit.map((entry) => entry.action),
			["proposed", "preview_requested", "previewed", "approved", "applied"],
		);
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, third.id, approval(ready)),
			status(409),
		);
		await reopen(state);
		assert.deepEqual(
			await state.store.renameProposal(projectId, dataset.id, conversation.id, third.id),
			applied.proposal,
		);
		const undone = await state.store.undoTransform(projectId, dataset.id, {
			expectedVersionId: applied.dataset.currentVersionId,
		});
		assert.equal(undone.currentVersionId, dataset.currentVersionId);
		assert.deepEqual(undone.schema, dataset.schema);
		assert.equal(
			(await state.store.renameProposal(projectId, dataset.id, conversation.id, third.id)).state,
			"applied",
		);
		assert.deepEqual(await readFile(originalPath), original);
	},
);

test(
	"invalid, cross-scope, undisclosed, duplicate and excessive batches fail atomically",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const valid = { toolCallId: "valid", datasetVersionId: dataset.currentVersionId, column: 0, name: "segment" };
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		for (const invalid of [
			{ ...valid, column: 2 },
			{ ...valid, column: 0.5 },
			{ ...valid, name: "private" },
			{ ...valid, datasetVersionId: randomUUID() },
			{ ...valid, oldName: "category" },
			{ ...valid, toolCallId: "\0" },
			{ ...valid, name: "" },
			{ ...valid, name: "x".repeat(257) },
		]) {
			await assert.rejects(
				state.store.putConversation(conversation, [valid, invalid]),
				(error: unknown) => error instanceof WorkbenchError,
			);
			assert.deepEqual(await state.store.renameProposals(projectId, dataset.id, conversation.id), []);
			assert.equal((await state.store.conversation(projectId, dataset.id, conversation.id)).state, "running");
		}
		await assert.rejects(state.store.putConversation(conversation, [valid, valid]), status(409));
		await assert.rejects(
			state.store.putConversation(
				conversation,
				Array.from({ length: 9 }, (_, i) => ({ ...valid, toolCallId: String(i) })),
			),
			status(409),
		);
		await state.store.putConversation(conversation, [valid]);
		const [proposal] = await state.store.renameProposals(projectId, dataset.id, conversation.id);
		const other = { ...conversation, id: randomUUID() };
		await state.store.putConversation(other);
		await assert.rejects(state.store.renameProposal(projectId, dataset.id, other.id, proposal.id), status(404));
		const otherProject = await state.store.createProject("Other project");
		await assert.rejects(state.store.renameProposals(otherProject.id, dataset.id, conversation.id), status(404));
		const altered = structuredClone(conversation);
		altered.scope.context.selectedColumns.push(2);
		await assert.rejects(state.store.putConversation(altered), status(409));
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		await assert.rejects(state.store.putConversation(conversation, [valid]), status(409));
		conversation.state = "failed";
		await state.store.putConversation(conversation);
	},
);

test(
	"proposal and conversation admission reject races before asynchronous work",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const proposal = await propose(state.store, conversation);
		const previewing = state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id);
		await assert.rejects(
			state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id),
			status(409),
		);
		await assert.rejects(
			state.store.rejectRenameProposal(projectId, dataset.id, conversation.id, proposal.id),
			status(409),
		);
		conversation.state = "running";
		await assert.rejects(state.store.putConversation(conversation), status(409));
		const preview = await previewing;
		await state.store.putConversation(conversation);
		await assert.rejects(
			state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id),
			status(409),
		);
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview)),
			status(409),
		);
		conversation.state = "ready";
		await state.store.putConversation(conversation);
		const applying = state.store.applyRenameProposal(
			projectId,
			dataset.id,
			conversation.id,
			proposal.id,
			approval(preview),
		);
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview)),
			status(409),
		);
		await assert.rejects(
			state.store.rejectRenameProposal(projectId, dataset.id, conversation.id, proposal.id),
			status(409),
		);
		const result = await applying;
		assert.equal(result.proposal.state, "applied");
		assert.equal(result.dataset.versions.length, dataset.versions.length + 1);
	},
);

test(
	"stale history, expired or discarded previews and changed artifacts cannot be approved",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const proposal = await propose(state.store, conversation);
		const preview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id);
		const manual = await state.store.previewTransform(projectId, dataset.id, {
			version: 1,
			datasetVersionId: dataset.currentVersionId,
			operation: { kind: "rename", column: 1, name: "amount" },
		});
		const changed = await state.store.applyTransform(projectId, dataset.id, { previewId: manual.id, approved: true });
		await state.store.undoTransform(projectId, dataset.id, { expectedVersionId: changed.currentVersionId });
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview)),
			status(409),
		);
		assert.equal(
			(await state.store.renameProposal(projectId, dataset.id, conversation.id, proposal.id)).state,
			"stale",
		);
		const next = await propose(state.store, conversation);
		let nextPreview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, next.id);
		await state.store.discardTransform(projectId, dataset.id, nextPreview.preview!.id);
		assert.equal((await state.store.renameProposal(projectId, dataset.id, conversation.id, next.id)).state, "failed");
		nextPreview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, next.id);
		const metadata = new DatabaseSync(join(state.root, "workbench.sqlite"));
		metadata
			.prepare("UPDATE transform_drafts SET metadata=json_set(metadata,'$.expiresAt',?) WHERE id=?")
			.run(new Date(0).toISOString(), nextPreview.preview!.id);
		metadata.close();
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, next.id, approval(nextPreview)),
			status(409),
		);
		const refreshed = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, next.id);
		assert.notEqual(refreshed.preview!.id, nextPreview.preview!.id);
		const draftPath = join(state.root, "transform-drafts", refreshed.preview!.id, "data.duckdb");
		const bytes = await readFile(draftPath);
		await writeFile(draftPath, Buffer.concat([bytes, Buffer.from("tamper")]));
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, next.id, approval(refreshed)),
			status(409),
		);
		assert.equal((await state.store.getDataset(projectId, dataset.id)).currentVersionId, dataset.currentVersionId);
		assert.deepEqual(
			(await state.store.renameProposal(projectId, dataset.id, conversation.id, next.id)).audit
				.slice(-2)
				.map((entry) => entry.action),
			["approved", "failed"],
		);
	},
);

test("altered preview specifications and counts fail closed", { timeout: 180_000 }, async (context) => {
	const { state, projectId, dataset, conversation } = await fixture(context);
	for (const path of ["$.spec.operation.name", "$.result.affectedRows", "$.result.schema[0].name"]) {
		const proposal = await propose(state.store, conversation);
		const preview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id);
		const metadata = new DatabaseSync(join(state.root, "workbench.sqlite"));
		metadata
			.prepare("UPDATE transforms SET metadata=json_set(metadata,?,?) WHERE id=?")
			.run(path, path.includes("name") ? "different" : 999, preview.preview!.id);
		metadata.close();
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview)),
			status(409),
		);
		assert.equal((await state.store.getDataset(projectId, dataset.id)).currentVersionId, dataset.currentVersionId);
		await state.store.rejectRenameProposal(projectId, dataset.id, conversation.id, proposal.id);
	}
});

test(
	"publication rolls back dataset and transform if applied proposal audit cannot commit",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const proposal = await propose(state.store, conversation);
		const preview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id);
		const metadata = new DatabaseSync(join(state.root, "workbench.sqlite"));
		metadata.exec(
			"CREATE TRIGGER fail_proposal_publication BEFORE UPDATE ON conversation_rename_proposals WHEN json_extract(NEW.metadata,'$.state')='applied' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
		);
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview)),
			status(500),
		);
		metadata.exec("DROP TRIGGER fail_proposal_publication");
		metadata.close();
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		const failed = await state.store.renameProposal(projectId, dataset.id, conversation.id, proposal.id);
		assert.equal(failed.outputVersionId, null);
		assert.equal(failed.state, "failed");
		assert.deepEqual(
			failed.audit.slice(-2).map((entry) => entry.action),
			["approved", "failed"],
		);
		const history = await state.store.transformHistory(projectId, dataset.id);
		assert.equal(history.records.find((record) => record.id === preview.preview!.id)?.state, "failed");
		assert.equal(history.canUndo, false);
		await reopen(state);
		assert.deepEqual(await state.store.renameProposal(projectId, dataset.id, conversation.id, proposal.id), failed);
		const retry = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, proposal.id);
		assert.equal(
			(await state.store.applyRenameProposal(projectId, dataset.id, conversation.id, proposal.id, approval(retry)))
				.proposal.state,
			"applied",
		);
	},
);

test(
	"restart fails interrupted turns and preview/apply intentions without replay",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const applying = await propose(state.store, conversation);
		const preview = await state.store.previewRenameProposal(projectId, dataset.id, conversation.id, applying.id);
		const previewing = await propose(state.store, conversation, "group");
		conversation.state = "running";
		await state.store.putConversation(conversation);
		await state.store.close();
		const metadata = new MetadataStore(join(state.root, "workbench.sqlite"));
		preview.state = "applying";
		preview.audit.push({ at: new Date().toISOString(), action: "approved", actor: "local-user" });
		metadata.putRenameProposal(preview);
		previewing.state = "previewing";
		previewing.audit.push({ at: new Date().toISOString(), action: "preview_requested", actor: "local-user" });
		metadata.putRenameProposal(previewing);
		metadata.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.equal((await state.store.conversation(projectId, dataset.id, conversation.id)).state, "failed");
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		for (const proposal of await state.store.renameProposals(projectId, dataset.id, conversation.id)) {
			assert.equal(proposal.state, "failed");
			assert.equal(proposal.audit.at(-1)?.action, "failed");
			assert.equal(proposal.outputVersionId, null);
		}
		await assert.rejects(
			state.store.applyRenameProposal(projectId, dataset.id, conversation.id, applying.id, approval(preview)),
			status(409),
		);
		await assert.rejects(state.store.applyTransform(projectId, dataset.id, approval(preview)), status(409));
		const before = await state.store.renameProposals(projectId, dataset.id, conversation.id);
		await reopen(state);
		assert.deepEqual(await state.store.renameProposals(projectId, dataset.id, conversation.id), before);
	},
);

test(
	"retained proposal limit rejects whole batches without pruning prior audit",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		for (let batch = 0; batch < 12; batch++) {
			conversation.state = "running";
			await state.store.putConversation(conversation);
			conversation.state = "ready";
			await state.store.putConversation(
				conversation,
				Array.from({ length: 8 }, (_, index) => ({
					toolCallId: `${batch}-${index}`,
					datasetVersionId: dataset.currentVersionId,
					column: 0,
					name: "segment",
				})),
			);
		}
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		const remaining = Array.from({ length: 5 }, (_, index) => ({
			toolCallId: `last-${index}`,
			datasetVersionId: dataset.currentVersionId,
			column: 0,
			name: "segment",
		}));
		await assert.rejects(state.store.putConversation(conversation, remaining), status(409));
		assert.equal((await state.store.renameProposals(projectId, dataset.id, conversation.id)).length, 96);
		await state.store.putConversation(conversation, remaining.slice(0, 4));
		conversation.state = "running";
		await assert.rejects(state.store.putConversation(conversation), status(409));
		assert.equal((await state.store.renameProposals(projectId, dataset.id, conversation.id)).length, 100);
	},
);

test(
	"failed and invalid driver turns publish neither proposals nor a successful transcript",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		let fail = true;
		const pi = await createFauxConversationDriver(state.root);
		context.after(async () => {
			await pi.driver.close();
			await pi.providers.close();
		});
		const service = new ConversationService(state.store, {
			...pi.driver,
			async chat(input, onEvent) {
				assert.deepEqual(input.renameScope, {
					datasetVersionId: dataset.currentVersionId,
					columns: [{ index: 0, name: "category" }],
				});
				onEvent({
					type: "rename_proposal",
					toolCallId: randomUUID(),
					datasetVersionId: dataset.currentVersionId,
					column: 0,
					name: "segment",
				});
				if (fail) throw new Error("interrupted driver");
				onEvent({
					type: "rename_proposal",
					toolCallId: randomUUID(),
					datasetVersionId: dataset.currentVersionId,
					column: 2,
					name: "secret",
				});
				return {
					modelState: conversation.modelState,
					sessionFile: "uncommitted-session.jsonl",
					text: "uncommitted answer",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				};
			},
		});
		context.after(() => service.close());
		for (let turn = 0; turn < 2; turn++) {
			const result = await service.send(projectId, dataset.id, conversation.id, { message: "Rename category" });
			assert.equal(result.state, "failed");
			assert.equal(result.sessionFile, null);
			assert.equal(result.usage.totalTokens, 0);
			assert.ok(result.messages.every((message) => message.role === "user" && message.state === "failed"));
			assert.deepEqual(await state.store.renameProposals(projectId, dataset.id, conversation.id), []);
			fail = false;
		}
	},
);

test(
	"model checkpoints remain separate from immutable disclosure and failed-turn commits",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId, dataset, conversation } = await fixture(context);
		const changed = structuredClone(conversation);
		changed.modelState.thinkingLevel = "xhigh";
		changed.reasoningEffort = "xhigh";
		changed.sessionFile = "selection-only.jsonl";
		await state.store.putConversation(changed);
		assert.deepEqual(
			(await state.store.conversation(projectId, dataset.id, conversation.id)).scope,
			conversation.scope,
		);
		const disclosure = structuredClone(changed);
		disclosure.scope.provider = "another-provider";
		await assert.rejects(state.store.putConversation(disclosure), status(409));
		changed.state = "running";
		await state.store.putConversation(changed);
		for (const replacement of [
			{ ...structuredClone(changed), state: "failed" as const, sessionFile: "uncommitted.jsonl" },
			{
				...structuredClone(changed),
				state: "failed" as const,
				modelState: { ...changed.modelState, thinkingLevel: "max" as const },
			},
		])
			await assert.rejects(state.store.putConversation(replacement), status(409));
		const unchanged = await state.store.conversation(projectId, dataset.id, conversation.id);
		assert.equal(unchanged.sessionFile, "selection-only.jsonl");
		assert.equal(unchanged.modelState.thinkingLevel, "xhigh");
		changed.state = "failed";
		await state.store.putConversation(changed);
		await reopen(state);
		assert.deepEqual(await state.store.conversation(projectId, dataset.id, conversation.id), changed);
	},
);
