import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, Dataset, ImportJob } from "../src/contracts.ts";
import type { Conversation, RenameProposal } from "../src/conversation-contracts.ts";
import { startWorkbench, type WorkbenchApplication } from "../src/server.ts";
import { WorkbenchStore } from "../src/storage.ts";
import { createFauxConversationDriver } from "./fixtures/conversation-faux-driver.ts";

test(
	"rename HTTP requires scoped exact-preview approval and retains decisions across restart",
	{ timeout: 180_000 },
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "datapi-rename-http-"));
		const seed = new WorkbenchStore(root);
		let app: WorkbenchApplication | undefined;
		t.after(async () => {
			await app?.close();
			await seed.close();
			await rm(root, { recursive: true, force: true });
		});
		await seed.init();
		const project = await seed.createProject("Rename approval");
		const other = await seed.createProject("Foreign project");
		const job = await seed.createImport(project.id, "values.csv");
		await seed.upload(
			project.id,
			job.id,
			(async function* () {
				yield Buffer.from("group,value\na,1\nb,2\n");
			})(),
		);
		async function settled(id: string): Promise<ImportJob> {
			// Real analytical subprocess completion cannot be advanced with the parent's fake clock.
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const value = seed.getJob(project.id, id);
				if (["completed", "failed", "cancelled"].includes(value.state)) return value;
				await delay(10);
			}
			throw Error("Analytical fixture did not settle");
		}
		const imported = await settled(job.id);
		assert.equal(imported.state, "completed", imported.error);
		assert.ok(imported.datasetId);
		const original = await seed.getDataset(project.id, imported.datasetId);
		assert.equal((await settled((await seed.profile(project.id, original.id)).id)).state, "completed");
		await seed.close();
		async function startApplication() {
			const pi = await createFauxConversationDriver(root, { rename: { column: 0, name: "cohort" } });
			return startWorkbench({ dataDir: root, port: 0, conversationDriver: pi.driver, providers: pi.providers });
		}
		app = await startApplication();
		let token = ((await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap).token;
		const base = `/api/projects/${project.id}/datasets/${original.id}`;
		async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
			return fetch(`${app!.url}${path}`, {
				method,
				headers: { "X-Workbench-Token": token, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		}
		const created = await request(`${base}/conversations`, "POST", {
			datasetVersionId: original.currentVersionId,
			selectedColumns: [0],
			filters: [],
			request: "Rename group to cohort",
			provider: "openai",
			modelId: "fixture",
		});
		assert.equal(created.status, 201, await created.clone().text());
		const conversation = (await created.json()) as Conversation;
		const chat = `${base}/conversations/${conversation.id}`;
		const sent = await request(`${chat}/messages`, "POST", { message: "Rename group to cohort" });
		assert.equal(sent.status, 200);
		assert.ok((await sent.text()).includes('"state":"ready"'));
		const proposals = (await (await request(`${chat}/proposals`)).json()) as RenameProposal[];
		assert.equal(proposals.length, 1);
		const proposal = proposals[0];
		assert.equal(proposal.state, "proposed");
		assert.equal(proposal.oldName, "group");
		const route = `${chat}/proposals/${proposal.id}`;
		assert.equal((await fetch(`${app.url}${chat}/proposals`)).status, 403);
		const foreign = route.replace(project.id, other.id);
		assert.equal((await request(`${foreign}/preview`, "POST")).status, 404);
		assert.equal(
			(await request(`${base}/conversations/${randomUUID()}/proposals/${proposal.id}/reject`, "POST")).status,
			404,
		);
		assert.ok((await request(`${route}/apply`, "POST", { previewId: randomUUID(), approved: true })).status >= 400);
		const prepared = await request(`${route}/preview`, "POST");
		assert.equal(prepared.status, 200, await prepared.clone().text());
		const previewed = (await prepared.json()) as RenameProposal;
		assert.ok(previewed.preview);
		assert.equal(previewed.state, "previewed");
		assert.equal(previewed.preview.inputRows, 2);
		assert.equal(previewed.preview.outputRows, 2);
		assert.equal("before" in previewed.preview, false);
		assert.equal("after" in previewed.preview, false);
		assert.equal(((await (await request(base)).json()) as Dataset).currentVersionId, original.currentVersionId);
		for (const body of [
			{ previewId: previewed.preview.id },
			{ previewId: previewed.preview.id, approved: false },
			{ previewId: previewed.preview.id, approved: true, name: "forged" },
		]) {
			assert.equal((await request(`${route}/apply`, "POST", body)).status, 400);
		}
		// Explicit rejection also discards staged output, never the original dataset.
		assert.equal((await request(`${route}/reject`, "POST")).status, 200);
		assert.ok(
			(await request(`${route}/apply`, "POST", { previewId: previewed.preview.id, approved: true })).status >= 400,
		);
		assert.equal(((await (await request(base)).json()) as Dataset).currentVersionId, original.currentVersionId);
		const second = await request(`${chat}/messages`, "POST", { message: "Propose the rename again" });
		await second.text();
		const next = ((await (await request(`${chat}/proposals`)).json()) as RenameProposal[]).find(
			(item) => item.id !== proposal.id,
		)!;
		assert.ok(next);
		const nextRoute = `${chat}/proposals/${next.id}`;
		const reviewed = (await (await request(`${nextRoute}/preview`, "POST")).json()) as RenameProposal;
		assert.ok(reviewed.preview);
		await app.close();
		app = await startApplication();
		token = ((await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap).token;
		const appliedResponse = await request(`${nextRoute}/apply`, "POST", {
			previewId: reviewed.preview.id,
			approved: true,
		});
		assert.equal(appliedResponse.status, 200, await appliedResponse.clone().text());
		const applied = (await appliedResponse.json()) as { proposal: RenameProposal; dataset: Dataset };
		assert.equal(applied.dataset.schema[0].name, "cohort");
		assert.equal(applied.dataset.sha256, original.sha256);
		assert.equal(applied.proposal.outputVersionId, applied.dataset.currentVersionId);
		assert.ok(applied.proposal.audit.some((event) => event.action === "approved" && event.actor === "local-user"));
		assert.equal(applied.proposal.state, "applied");
		assert.ok(
			(await request(`${nextRoute}/apply`, "POST", { previewId: reviewed.preview.id, approved: true })).status >=
				400,
		);
		const persisted = (await (await request(`${chat}/proposals`)).json()) as RenameProposal[];
		assert.equal(persisted.find((item) => item.id === proposal.id)?.state, "rejected");
		assert.equal(persisted.find((item) => item.id === next.id)?.state, "applied");
		const undo = await request(`${base}/transforms/undo`, "POST", {
			expectedVersionId: applied.dataset.currentVersionId,
		});
		assert.equal(undo.status, 200, await undo.clone().text());
		assert.equal(((await undo.json()) as Dataset).schema[0].name, "group");
	},
);
