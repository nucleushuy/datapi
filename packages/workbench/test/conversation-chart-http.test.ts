import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChartRecord } from "../src/chart-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type { Bootstrap, Dataset } from "../src/contracts.ts";
import type {
	ChartProposal,
	Conversation,
	ConversationChartPreview,
	ConversationChartSaved,
} from "../src/conversation-contracts.ts";
import { startWorkbench, type WorkbenchApplication } from "../src/server.ts";
import { WorkbenchStore } from "../src/storage.ts";
import { createFauxConversationDriver } from "./fixtures/conversation-faux-driver.ts";

test(
	"chart HTTP preview and explicit save retain scoped evidence and decisions across restart",
	{ timeout: 180_000 },
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "datapi-chart-http-"));
		const seed = new WorkbenchStore(root);
		let app: WorkbenchApplication | undefined;
		t.after(async () => {
			await app?.close();
			await seed.close();
			await rm(root, { recursive: true, force: true });
		});
		await seed.init();
		const project = await seed.createProject("Chart proposals");
		const other = await seed.createProject("Foreign project");
		const job = await seed.createImport(project.id, "observations.csv");
		await seed.upload(
			project.id,
			job.id,
			(async function* () {
				yield Buffer.from("group,value,private_note\na,1,secret-one\nb,2,secret-two\na,3,secret-three\n");
			})(),
		);
		async function settled(id: string) {
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const result = seed.getJob(project.id, id);
				if (["completed", "failed", "cancelled"].includes(result.state)) {
					assert.equal(result.state, "completed", result.error);
					return result;
				}
				await delay(10);
			}
			throw Error("Chart fixture timed out");
		}
		const imported = await settled(job.id);
		assert.ok(imported.datasetId);
		const original = await seed.getDataset(project.id, imported.datasetId);
		await settled((await seed.profile(project.id, original.id)).id);
		await seed.close();
		async function startApplication() {
			const pi = await createFauxConversationDriver(root, { chart: {
				title: "Counts by group",
				explanation: "Compare observed categories; counts will be computed locally, not inferred from profile statistics.",
				evidenceRefs: ["column.0.distinctCount"], affectedColumns: [0],
				spec: { ...defaultChartSpec(original.currentVersionId), x: 0 },
			} });
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
			selectedColumns: [0, 1],
			filters: [],
			request: "Chart count by group",
			provider: "openai",
			modelId: "fixture",
		});
		assert.equal(created.status, 201, await created.clone().text());
		const conversation = (await created.json()) as Conversation;
		const chat = `${base}/conversations/${conversation.id}`;
		async function propose() {
			const sent = await request(`${chat}/messages`, "POST", { message: "Chart count by group" });
			assert.equal(sent.status, 200);
			assert.match(await sent.text(), /"state":"ready"/u);
			return (await (await request(`${chat}/chart-proposals`)).json()) as ChartProposal[];
		}
		const [proposal] = await propose();
		assert.equal(proposal.basis, "evidence-linked");
		assert.deepEqual(proposal.evidenceRefs, ["column.0.distinctCount"]);
		const route = `${chat}/chart-proposals/${proposal.id}`;
		assert.equal((await fetch(`${app.url}${chat}/chart-proposals`)).status, 403);
		assert.equal((await request(`${route.replace(project.id, other.id)}/preview`, "POST")).status, 404);
		assert.equal(
			(await request(`${base}/conversations/${randomUUID()}/chart-proposals/${proposal.id}/reject`, "POST")).status,
			404,
		);
		assert.ok((await request(`${route}/save`, "POST", { previewId: randomUUID(), approved: true })).status >= 400);
		assert.equal((await request(`${route}/preview`, "POST", {})).status, 400);
		const prepared = await request(`${route}/preview`, "POST");
		assert.equal(prepared.status, 200, await prepared.clone().text());
		const preview = (await prepared.json()) as ConversationChartPreview;
		assert.equal(preview.proposal.state, "previewed");
		assert.ok(preview.proposal.preview);
		assert.equal(preview.chart.sampleSize, 3);
		assert.equal(preview.chart.populationRows, 3);
		assert.deepEqual(preview.chart.marks.map((mark) => mark.value).sort(), [1, 2]);
		assert.doesNotMatch(JSON.stringify(preview), /secret-one|secret-two|secret-three/);
		assert.deepEqual((await (await request(`${base}/charts`)).json()) as ChartRecord[], []);
		assert.equal(((await (await request(base)).json()) as Dataset).currentVersionId, original.currentVersionId);
		for (const invalid of [
			{ previewId: preview.proposal.preview.id },
			{ previewId: preview.proposal.preview.id, approved: false },
			{ previewId: preview.proposal.preview.id, approved: true, name: "forged" },
		])
			assert.equal((await request(`${route}/save`, "POST", invalid)).status, 400);
		assert.equal((await request(`${route}/reject`, "POST")).status, 200);
		assert.ok(
			(await request(`${route}/save`, "POST", { previewId: preview.proposal.preview.id, approved: true })).status >=
				400,
		);
		const next = (await propose()).find((item) => item.id !== proposal.id)!;
		assert.ok(next);
		const nextRoute = `${chat}/chart-proposals/${next.id}`;
		const reviewedResponse = await request(`${nextRoute}/preview`, "POST");
		assert.equal(reviewedResponse.status, 200, await reviewedResponse.clone().text());
		const reviewed = (await reviewedResponse.json()) as ConversationChartPreview;
		assert.ok(reviewed.proposal.preview);
		await app.close();
		app = await startApplication();
		token = ((await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap).token;
		const savedResponse = await request(`${nextRoute}/save`, "POST", {
			previewId: reviewed.proposal.preview.id,
			approved: true,
		});
		assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
		const saved = (await savedResponse.json()) as ConversationChartSaved;
		assert.equal(saved.proposal.state, "saved");
		assert.equal(saved.proposal.chartId, saved.chart.id);
		assert.deepEqual(saved.chart.spec, reviewed.chart.spec);
		assert.ok(saved.proposal.audit.some((event) => event.action === "approved" && event.actor === "local-user"));
		assert.deepEqual((await (await request(`${base}/charts`)).json()) as ChartRecord[], [saved.chart]);
		assert.deepEqual((await (await request(base)).json()) as Dataset, original);
		assert.ok(
			(await request(`${nextRoute}/save`, "POST", { previewId: reviewed.proposal.preview.id, approved: true }))
				.status >= 400,
		);
		await app.close();
		app = await startApplication();
		token = ((await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap).token;
		const persisted = (await (await request(`${chat}/chart-proposals`)).json()) as ChartProposal[];
		assert.equal(persisted.find((item) => item.id === proposal.id)?.state, "rejected");
		assert.equal(persisted.find((item) => item.id === next.id)?.chartId, saved.chart.id);
	},
);
