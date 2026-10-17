import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantContext } from "../src/assistant-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type {
	ChartProposal,
	ChartProposalInput,
	Conversation,
	RenameProposalInput,
} from "../src/conversation-contracts.ts";
import { ConversationService } from "../src/conversation-service.ts";
import { MetadataStore } from "../src/metadata.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";
import { createFauxConversationDriver } from "./fixtures/conversation-faux-driver.ts";

function status(code: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === code;
}

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (!["uploading", "processing"].includes(job.state)) {
			assert.equal(job.state, "completed", job.error);
			return;
		}
		await delay(10);
	}
	throw new Error("Fixture job did not settle.");
}

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "workbench-chart-proposals-"));
	const state = { root, store: new WorkbenchStore(root) };
	context.after(async () => {
		await state.store.close();
		await rm(root, { recursive: true, force: true });
	});
	await state.store.init();
	const project = await state.store.createProject("Chart proposals");
	const job = await state.store.createImport(project.id, "source.csv");
	await state.store.upload(
		project.id,
		job.id,
		(async function* () {
			yield Buffer.from("category,value,private\nA,1,first-secret\nB,2,second-secret\n");
		})(),
	);
	await waitJob(state.store, project.id, job.id);
	const datasetId = state.store.getJob(project.id, job.id).datasetId!;
	const profileJob = await state.store.profile(project.id, datasetId);
	await waitJob(state.store, project.id, profileJob.id);
	const dataset = await state.store.getDataset(project.id, datasetId);
	const version = dataset.versions.find((entry) => entry.id === dataset.currentVersionId)!;
	const disclosure: AssistantContext = {
		version: 1,
		project: { id: project.id, name: project.name, description: project.description },
		dataset: {
			id: dataset.id,
			name: dataset.name,
			versionId: dataset.currentVersionId,
			artifactHash: version.facts!.artifactSha256,
			rowCount: dataset.rowCount,
			columnCount: dataset.columnCount,
		},
		schema: dataset.schema.slice(0, 2),
		selectedColumns: [0, 1],
		filters: [],
		evidence: [
			{
				id: "column:1:missing",
				metric: "missingCount",
				value: 0,
				columns: [1],
				basis: "full",
				rows: 2,
				approximate: false,
			},
		],
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
		title: "Chart value by category",
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
	const input: ChartProposalInput = {
		toolCallId: randomUUID(),
		title: "Value by category",
		explanation: "Compare values across the disclosed categories.",
		confidence: 0.9,
		evidenceRefs: [],
		affectedColumns: [0, 1],
		spec: { ...defaultChartSpec(dataset.currentVersionId), type: "bar", x: 0, y: 1, aggregation: "sum" },
	};
	return {
		state,
		projectId: project.id,
		dataset,
		conversation,
		input,
		artifactPath: join(root, version.storageLocation),
	};
}

async function propose(
	store: WorkbenchStore,
	conversation: Conversation,
	input: ChartProposalInput,
): Promise<ChartProposal> {
	const current = await store.conversation(conversation.projectId, conversation.datasetId, conversation.id);
	current.state = "running";
	await store.putConversation(current);
	current.state = "ready";
	const next = { ...input, toolCallId: randomUUID() };
	await store.putConversation(current, [], [next]);
	return (await store.chartProposals(current.projectId, current.datasetId, current.id)).find(
		(proposal) => proposal.toolCallId === next.toolCallId,
	)!;
}

function approval(proposal: ChartProposal) {
	assert.ok(proposal.preview);
	return { previewId: proposal.preview.id, approved: true };
}

async function reopen(state: { root: string; store: WorkbenchStore }): Promise<void> {
	await state.store.close();
	state.store = new WorkbenchStore(state.root);
	await state.store.init();
}

test(
	"chart proposals normalize evidence and save exact local previews without changing the dataset",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input, artifactPath } = await fixture(context);
		const before = await readFile(artifactPath);
		const hypothesis = await propose(state.store, conversation, input);
		assert.equal(hypothesis.confidence, 0.5);
		assert.equal(hypothesis.basis, "hypothesis");
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, hypothesis.id, {
				previewId: randomUUID(),
				approved: true,
			}),
			status(409),
		);
		const rejected = await state.store.rejectChartProposal(projectId, dataset.id, conversation.id, hypothesis.id);
		assert.equal(rejected.state, "rejected");
		await assert.rejects(
			state.store.previewChartProposal(projectId, dataset.id, conversation.id, hypothesis.id),
			status(409),
		);
		const linked = await propose(state.store, conversation, { ...input, evidenceRefs: ["column:1:missing"] });
		assert.equal(linked.confidence, 0.9);
		assert.equal(linked.basis, "evidence-linked");
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
		const first = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, linked.id);
		assert.equal(first.chart.marks.length, 2);
		const planning = await state.store.conversation(projectId, dataset.id, conversation.id);
		planning.mode = "plan";
		await state.store.putConversation(planning);
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, linked.id, approval(first.proposal)),
			/Plan mode cannot save charts/,
		);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
		assert.equal(
			(await state.store.chartProposal(projectId, dataset.id, conversation.id, linked.id)).state,
			"previewed",
		);
		planning.mode = "execute";
		await state.store.putConversation(planning);
		assert.deepEqual(first.chart.spec, linked.spec);
		assert.deepEqual(Object.keys(first.proposal.preview!).sort(), [
			"datasetVersionHash",
			"expiresAt",
			"id",
			"populationRows",
			"sampleSize",
			"sampled",
			"specHash",
		]);
		assert.equal(JSON.stringify(first.proposal).includes("first-secret"), false);
		assert.equal("marks" in first.proposal.preview!, false);
		const db = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			const persisted = JSON.parse(
				String(db.prepare("SELECT metadata FROM conversation_chart_proposals WHERE id=?").get(linked.id)?.metadata),
			);
			assert.deepEqual(persisted, first.proposal);
			assert.equal(JSON.stringify(persisted).includes('"marks"'), false);
			assert.equal(JSON.stringify(persisted).includes('"table"'), false);
		} finally {
			db.close();
		}
		const fresh = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, linked.id);
		assert.notEqual(fresh.proposal.preview!.id, first.proposal.preview!.id);
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, linked.id, approval(first.proposal)),
			status(409),
		);
		for (const body of [
			{ previewId: fresh.proposal.preview!.id },
			{ ...approval(fresh.proposal), approved: false },
			{ ...approval(fresh.proposal), spec: input.spec },
		])
			await assert.rejects(
				state.store.saveChartProposal(projectId, dataset.id, conversation.id, linked.id, body),
				status(400),
			);
		const saved = await state.store.saveChartProposal(
			projectId,
			dataset.id,
			conversation.id,
			linked.id,
			approval(fresh.proposal),
		);
		assert.equal(saved.proposal.state, "saved");
		assert.equal(saved.proposal.chartId, saved.chart.id);
		assert.deepEqual(saved.chart.spec, linked.spec);
		assert.deepEqual(
			saved.proposal.audit.map((entry) => entry.action),
			["proposed", "preview_requested", "previewed", "preview_requested", "previewed", "approved", "saved"],
		);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), [saved.chart]);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await readFile(artifactPath), before);
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, linked.id, approval(fresh.proposal)),
			status(409),
		);
		await assert.rejects(
			state.store.rejectChartProposal(projectId, dataset.id, conversation.id, linked.id),
			status(409),
		);
		await reopen(state);
		assert.deepEqual(
			await state.store.chartProposal(projectId, dataset.id, conversation.id, linked.id),
			saved.proposal,
		);
		assert.deepEqual(
			await state.store.chartProposal(projectId, dataset.id, conversation.id, hypothesis.id),
			rejected,
		);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), [saved.chart]);
	},
);

test(
	"mixed proposal batches reject hidden fields, malformed disclosures, duplicates and limits atomically",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		const rename: RenameProposalInput = {
			toolCallId: "rename",
			datasetVersionId: dataset.currentVersionId,
			column: 0,
			name: "segment",
		};
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		for (const invalid of [
			{ ...input, affectedColumns: [0, 1, 2] },
			{ ...input, spec: { ...input.spec, color: 2 } },
			{ ...input, spec: { ...input.spec, filters: [{ column: 2, op: "eq", value: "secret" }] } },
			{ ...input, spec: { ...input.spec, datasetVersionId: randomUUID() } },
			{ ...input, evidenceRefs: ["not-disclosed"] },
			{ ...input, title: "x".repeat(121) },
			{ ...input, approved: true },
			{ ...input, toolCallId: "\0" },
		]) {
			await assert.rejects(
				state.store.putConversation(conversation, [rename], [invalid as ChartProposalInput]),
				(error: unknown) => error instanceof WorkbenchError,
			);
			assert.deepEqual(await state.store.chartProposals(projectId, dataset.id, conversation.id), []);
			assert.deepEqual(await state.store.renameProposals(projectId, dataset.id, conversation.id), []);
			assert.equal((await state.store.conversation(projectId, dataset.id, conversation.id)).state, "running");
		}
		await assert.rejects(
			state.store.putConversation(conversation, [rename], [{ ...input, toolCallId: rename.toolCallId }]),
			status(409),
		);
		await assert.rejects(
			state.store.putConversation(
				conversation,
				[rename],
				Array.from({ length: 8 }, (_, index) => ({ ...input, toolCallId: `chart-${index}` })),
			),
			status(409),
		);
		await state.store.putConversation(conversation, [rename], [input]);
		const [proposal] = await state.store.chartProposals(projectId, dataset.id, conversation.id);
		const other = { ...conversation, id: randomUUID() };
		await state.store.putConversation(other);
		await assert.rejects(state.store.chartProposal(projectId, dataset.id, other.id, proposal.id), status(404));
		await assert.rejects(state.store.previewChartProposal(projectId, dataset.id, other.id, proposal.id), status(404));
		const otherProject = await state.store.createProject("Other");
		await assert.rejects(state.store.chartProposals(otherProject.id, dataset.id, conversation.id), status(404));
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		await assert.rejects(
			state.store.putConversation(conversation, [], [{ ...input, toolCallId: rename.toolCallId }]),
			status(409),
		);
		await state.store.putConversation(conversation);
		const forged = structuredClone(conversation);
		forged.id = randomUUID();
		forged.scope.context.schema[0].name = "forged";
		forged.scope.contextHash = createHash("sha256").update(JSON.stringify(forged.scope.context)).digest("hex");
		await state.store.putConversation(forged);
		forged.state = "running";
		await state.store.putConversation(forged);
		forged.state = "ready";
		await assert.rejects(state.store.putConversation(forged, [], [input]), status(409));
	},
);

test(
	"chat, rename and chart actions cannot overwrite concurrent proposal operations",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		const proposal = await propose(state.store, conversation, input);
		const sibling = await propose(state.store, conversation, input);
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		await state.store.putConversation(conversation, [
			{ toolCallId: "rename", datasetVersionId: dataset.currentVersionId, column: 0, name: "segment" },
		]);
		const [rename] = await state.store.renameProposals(projectId, dataset.id, conversation.id);
		const previewing = state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id);
		await assert.rejects(
			state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id),
			status(409),
		);
		await assert.rejects(
			state.store.rejectChartProposal(projectId, dataset.id, conversation.id, sibling.id),
			status(409),
		);
		await assert.rejects(
			state.store.previewRenameProposal(projectId, dataset.id, conversation.id, rename.id),
			status(409),
		);
		conversation.state = "running";
		await assert.rejects(state.store.putConversation(conversation), status(409));
		const preview = await previewing;
		const saving = state.store.saveChartProposal(
			projectId,
			dataset.id,
			conversation.id,
			proposal.id,
			approval(preview.proposal),
		);
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview.proposal)),
			status(409),
		);
		await assert.rejects(
			state.store.rejectChartProposal(projectId, dataset.id, conversation.id, proposal.id),
			status(409),
		);
		await saving;
		assert.equal((await state.store.listCharts(projectId, dataset.id)).length, 1);
		await state.store.putConversation(conversation);
		await assert.rejects(
			state.store.previewChartProposal(projectId, dataset.id, conversation.id, sibling.id),
			status(409),
		);
	},
);

test("expired, tampered or stale chart receipts cannot save", { timeout: 240_000 }, async (context) => {
	const { state, projectId, dataset, conversation, input, artifactPath } = await fixture(context);
	for (const [path, value] of [
		["$.preview.expiresAt", new Date(0).toISOString()],
		["$.preview.sampleSize", 999],
		["$.preview.specHash", "altered"],
	] as const) {
		const proposal = await propose(state.store, conversation, input);
		const preview = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id);
		const db = new DatabaseSync(join(state.root, "workbench.sqlite"));
		db.prepare("UPDATE conversation_chart_proposals SET metadata=json_set(metadata,?,?) WHERE id=?").run(
			path,
			value,
			proposal.id,
		);
		db.close();
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview.proposal)),
			status(409),
		);
		assert.equal(
			(await state.store.chartProposal(projectId, dataset.id, conversation.id, proposal.id)).state,
			"failed",
		);
		const refreshed = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id);
		assert.notEqual(refreshed.proposal.preview!.id, preview.proposal.preview!.id);
		await state.store.rejectChartProposal(projectId, dataset.id, conversation.id, proposal.id);
	}
	const corrupt = await propose(state.store, conversation, input);
	const corruptPreview = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, corrupt.id);
	const before = await readFile(artifactPath);
	await writeFile(artifactPath, Buffer.concat([before, Buffer.from("tamper")]));
	await assert.rejects(
		state.store.saveChartProposal(
			projectId,
			dataset.id,
			conversation.id,
			corrupt.id,
			approval(corruptPreview.proposal),
		),
		status(409),
	);
	await writeFile(artifactPath, before);
	const stale = await propose(state.store, conversation, input);
	const stalePreview = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, stale.id);
	const manual = await state.store.previewTransform(projectId, dataset.id, {
		version: 1,
		datasetVersionId: dataset.currentVersionId,
		operation: { kind: "rename", column: 1, name: "amount" },
	});
	const changed = await state.store.applyTransform(projectId, dataset.id, { previewId: manual.id, approved: true });
	assert.equal((await state.store.chartProposal(projectId, dataset.id, conversation.id, stale.id)).state, "stale");
	await state.store.undoTransform(projectId, dataset.id, { expectedVersionId: changed.currentVersionId });
	await assert.rejects(
		state.store.saveChartProposal(projectId, dataset.id, conversation.id, stale.id, approval(stalePreview.proposal)),
		status(409),
	);
	assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
	const restored = await state.store.getDataset(projectId, dataset.id);
	assert.equal(restored.currentVersionId, dataset.currentVersionId);
	assert.deepEqual(restored.schema, dataset.schema);
	assert.equal(restored.rowCount, dataset.rowCount);
	assert.deepEqual(await readFile(artifactPath), before);
});

test(
	"changed proposal specs and failed audit transactions never create phantom charts",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		const proposal = await propose(state.store, conversation, input);
		const preview = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id);
		const db = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			db.exec(
				"CREATE TRIGGER fail_chart_save BEFORE UPDATE ON conversation_chart_proposals WHEN json_extract(NEW.metadata,'$.state')='saved' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
			);
			await assert.rejects(
				state.store.saveChartProposal(
					projectId,
					dataset.id,
					conversation.id,
					proposal.id,
					approval(preview.proposal),
				),
				status(500),
			);
			db.exec("DROP TRIGGER fail_chart_save");
			const failed = await state.store.chartProposal(projectId, dataset.id, conversation.id, proposal.id);
			assert.equal(failed.state, "failed");
			assert.equal(failed.chartId, null);
			assert.deepEqual(
				failed.audit.slice(-2).map((entry) => entry.action),
				["approved", "failed"],
			);
			assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
			const retry = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id);
			db.prepare(
				"UPDATE conversation_chart_proposals SET metadata=json_set(metadata,'$.spec.aggregation','mean') WHERE id=?",
			).run(proposal.id);
			await assert.rejects(
				state.store.saveChartProposal(
					projectId,
					dataset.id,
					conversation.id,
					proposal.id,
					approval(retry.proposal),
				),
				status(409),
			);
			assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
			assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		} finally {
			db.close();
		}
	},
);

test(
	"interrupted previews fail on restart without replay and preserve terminal audit",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		const pending = await propose(state.store, conversation, input);
		const terminal = await propose(state.store, conversation, input);
		const rejected = await state.store.rejectChartProposal(projectId, dataset.id, conversation.id, terminal.id);
		conversation.state = "running";
		await state.store.putConversation(conversation);
		await state.store.close();
		const metadata = new MetadataStore(join(state.root, "workbench.sqlite"));
		pending.state = "previewing";
		pending.audit.push({ at: new Date().toISOString(), action: "preview_requested", actor: "local-user" });
		metadata.putChartProposal(pending);
		metadata.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const recovered = await state.store.chartProposal(projectId, dataset.id, conversation.id, pending.id);
		assert.equal(recovered.state, "failed");
		assert.equal(recovered.preview, null);
		assert.equal(recovered.chartId, null);
		assert.equal(recovered.audit.at(-1)?.action, "failed");
		assert.equal((await state.store.conversation(projectId, dataset.id, conversation.id)).state, "failed");
		assert.deepEqual(await state.store.chartProposal(projectId, dataset.id, conversation.id, terminal.id), rejected);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		await reopen(state);
		assert.deepEqual(await state.store.chartProposal(projectId, dataset.id, conversation.id, pending.id), recovered);
	},
);

test(
	"retained mixed proposals and ordinary saved charts enforce their shared limits",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		for (let batch = 0; batch < 12; batch++) {
			conversation.state = "running";
			await state.store.putConversation(conversation);
			conversation.state = "ready";
			await state.store.putConversation(
				conversation,
				Array.from({ length: 4 }, (_, index) => ({
					toolCallId: `rename-${batch}-${index}`,
					datasetVersionId: dataset.currentVersionId,
					column: 0,
					name: "segment",
				})),
				Array.from({ length: 4 }, (_, index) => ({ ...input, toolCallId: `chart-${batch}-${index}` })),
			);
		}
		conversation.state = "running";
		await state.store.putConversation(conversation);
		conversation.state = "ready";
		const remaining = Array.from({ length: 5 }, (_, index) => ({ ...input, toolCallId: `remaining-${index}` }));
		await assert.rejects(state.store.putConversation(conversation, [], remaining), status(409));
		assert.equal((await state.store.chartProposals(projectId, dataset.id, conversation.id)).length, 48);
		await state.store.putConversation(conversation, [], remaining.slice(0, 4));
		conversation.state = "running";
		await assert.rejects(state.store.putConversation(conversation), status(409));
		for (let index = 0; index < 100; index++)
			await state.store.createChart(projectId, dataset.id, `Chart ${index}`, input.spec);
		const [proposal] = await state.store.chartProposals(projectId, dataset.id, conversation.id);
		const preview = await state.store.previewChartProposal(projectId, dataset.id, conversation.id, proposal.id);
		await assert.rejects(
			state.store.saveChartProposal(projectId, dataset.id, conversation.id, proposal.id, approval(preview.proposal)),
			status(409),
		);
		assert.equal((await state.store.listCharts(projectId, dataset.id)).length, 100);
		assert.equal(
			(await state.store.chartProposal(projectId, dataset.id, conversation.id, proposal.id)).chartId,
			null,
		);
	},
);

test(
	"failed or malformed driver turns publish no mixed proposals or completed transcript",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		let turn = 0;
		const pi = await createFauxConversationDriver(state.root);
		context.after(async () => {
			await pi.driver.close();
			await pi.providers.close();
		});
		const service = new ConversationService(state.store, {
			...pi.driver,
			async chat(scope, onEvent) {
				assert.deepEqual(scope.chartScope, conversation.scope.context);
				assert.equal(JSON.stringify(scope).includes("first-secret"), false);
				onEvent({
					type: "rename_proposal",
					toolCallId: randomUUID(),
					datasetVersionId: dataset.currentVersionId,
					column: 0,
					name: "segment",
				});
				onEvent({ type: "chart_proposal", ...input, toolCallId: randomUUID() });
				if (turn === 0) throw new Error("interrupted driver");
				onEvent({
					type: "chart_proposal",
					...input,
					toolCallId: randomUUID(),
					...(turn === 1 ? { affectedColumns: [2] } : { approved: true }),
				});
				return {
					modelState: conversation.modelState,
					sessionFile: "uncommitted.jsonl",
					text: "uncommitted answer",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				};
			},
		});
		context.after(() => service.close());
		for (; turn < 3; turn++) {
			const result = await service.send(projectId, dataset.id, conversation.id, { message: "Chart these values" });
			assert.equal(result.state, "failed");
			assert.equal(result.sessionFile, null);
			assert.equal(result.usage.totalTokens, 0);
			assert.ok(result.messages.every((message) => message.role === "user" && message.state === "failed"));
			assert.deepEqual(await state.store.chartProposals(projectId, dataset.id, conversation.id), []);
			assert.deepEqual(await state.store.renameProposals(projectId, dataset.id, conversation.id), []);
		}
	},
);

test(
	"successful driver proposals are detached from mutable SDK events and disclosure inputs",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		const pi = await createFauxConversationDriver(state.root);
		context.after(async () => {
			await pi.driver.close();
			await pi.providers.close();
		});
		const service = new ConversationService(state.store, {
			...pi.driver,
			async chat(scope, onEvent, signal) {
				assert.deepEqual(scope.chartScope, conversation.scope.context);
				const actual = await pi.driver.chat(scope, () => {}, signal);
				const event = { type: "chart_proposal" as const, ...structuredClone(input) };
				onEvent(event);
				event.spec.x = 2;
				event.affectedColumns.push(2);
				scope.chartScope!.schema[0].name = "mutated driver copy";
				return {
					...actual,
					text: "Review the proposed chart locally.",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				};
			},
		});
		context.after(() => service.close());
		const result = await service.send(projectId, dataset.id, conversation.id, { message: "Chart these values" });
		assert.equal(result.state, "ready");
		assert.equal(result.messages.at(-1)?.role, "assistant");
		assert.deepEqual(result.scope, conversation.scope);
		const [proposal] = await state.store.chartProposals(projectId, dataset.id, conversation.id);
		assert.deepEqual(proposal.spec, input.spec);
		assert.deepEqual(proposal.affectedColumns, input.affectedColumns);
		assert.equal(proposal.state, "proposed");
		assert.equal(proposal.preview, null);
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
	},
);

test(
	"schema eight upgrades chart proposal storage without changing conversations or datasets",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		await state.store.close();
		const db = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			db.exec("DROP TABLE conversation_chart_proposals; PRAGMA user_version=8;");
		} finally {
			db.close();
		}
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(await state.store.conversation(projectId, dataset.id, conversation.id), conversation);
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await state.store.chartProposals(projectId, dataset.id, conversation.id), []);
		assert.equal((await propose(state.store, conversation, input)).state, "proposed");
	},
);

test(
	"count-only charts cannot implicitly sample a column omitted from disclosure",
	{ timeout: 180_000 },
	async (context) => {
		const { state, projectId, dataset, conversation, input } = await fixture(context);
		const restricted = structuredClone(conversation);
		restricted.id = randomUUID();
		restricted.scope.context.schema = [dataset.schema[1]];
		restricted.scope.context.selectedColumns = [1];
		restricted.scope.contextHash = createHash("sha256")
			.update(JSON.stringify(restricted.scope.context))
			.digest("hex");
		await state.store.putConversation(restricted);
		restricted.state = "running";
		await state.store.putConversation(restricted);
		restricted.state = "ready";
		await assert.rejects(
			state.store.putConversation(
				restricted,
				[],
				[
					{
						...input,
						affectedColumns: [],
						spec: {
							...input.spec,
							type: "bar",
							aggregation: "count",
							x: null,
							y: null,
							color: null,
							size: null,
							facet: null,
							filters: [],
						},
					},
				],
			),
			status(400),
		);
		assert.deepEqual(await state.store.chartProposals(projectId, dataset.id, restricted.id), []);
		assert.equal((await state.store.conversation(projectId, dataset.id, restricted.id)).state, "running");
		assert.deepEqual(await state.store.listCharts(projectId, dataset.id), []);
	},
);
