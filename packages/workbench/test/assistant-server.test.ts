import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantDraft, AssistantDriver, AssistantRun, AssistantUsage } from "../src/assistant-contracts.ts";
import { defaultChartSpec } from "../src/chart-spec.ts";
import type { Bootstrap, Dataset, ImportJob } from "../src/contracts.ts";
import { startWorkbench } from "../src/server.ts";
import { WorkbenchStore } from "../src/storage.ts";

const usage: AssistantUsage = { input: 140, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 200 };
async function settled(store: WorkbenchStore, projectId: string, job: ImportJob): Promise<ImportJob> {
	for (let attempt = 0; attempt < 1200; attempt++) {
		const current = store.getJob(projectId, job.id);
		if (["completed", "cancelled", "failed"].includes(current.state)) {
			assert.equal(current.state, "completed", current.error);
			return current;
		}
		await delay(50);
	}
	throw new Error("Fixture operation did not settle.");
}

async function seed(root: string): Promise<{ projectId: string; otherId: string; dataset: Dataset }> {
	const store = new WorkbenchStore(root);
	await store.init();
	try {
		const project = await store.createProject("Machine study");
		const other = await store.createProject("Other project");
		const reservation = await store.createImport(project.id, "machines.csv");
		await store.upload(
			project.id,
			reservation.id,
			(async function* () {
				yield Buffer.from(
					"time,machine,failure,private_note\n2026-01-01,A,0,PRIVATE-CELL-ONE\n2026-01-02,A,1,PRIVATE-CELL-TWO\n2026-01-01,B,1,PRIVATE-CELL-THREE\n2026-01-02,B,0,PRIVATE-CELL-FOUR\n",
				);
			})(),
		);
		const imported = await settled(store, project.id, reservation);
		assert.ok(imported.datasetId);
		const dataset = await store.getDataset(project.id, imported.datasetId);
		await settled(store, project.id, await store.profile(project.id, dataset.id));
		return { projectId: project.id, otherId: other.id, dataset };
	} finally {
		await store.close();
	}
}

test(
	"assistant HTTP requires approved exact context, scopes every action, and persists preview/apply/revert",
	{ timeout: 180_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-assistant-http-"));
		const { projectId, otherId, dataset } = await seed(root);
		let calls = 0;
		let approved: AssistantDraft | undefined;
		const spec = {
			...defaultChartSpec(dataset.currentVersionId),
			type: "line" as const,
			x: 0,
			y: 2,
			facet: 1,
			aggregation: "mean" as const,
		};
		const driver: AssistantDriver = {
			async models() {
				return {
					models: [
						{
							provider: "fixture",
							id: "fixture-model",
							name: "Offline fixture",
							configured: true,
							contextWindow: 100_000,
						},
					],
					guidance: "No network",
				};
			},
			async generate(input, progress) {
				calls++;
				assert.deepEqual(input.payload, approved?.payload);
				assert.doesNotMatch(JSON.stringify(input.payload), /PRIVATE-CELL-|storageLocation|workbench.sqlite/);
				progress({ type: "progress", receivedCharacters: 50 });
				progress({ type: "usage", usage });
				await delay(150);
				return {
					text: JSON.stringify({
						summary: "Compare average binary failure by machine over time; interpretation requires validation.",
						suggestions: [
							{
								id: "compare-failure",
								category: "visualization",
								title: "Failure rate by machine over time",
								explanation:
									"Use the mean of the binary failure field as a rate; inspect the data and sampling before interpreting differences.",
								priority: "medium",
								confidence: 0.5,
								evidenceRefs: [],
								affectedColumns: [0, 1, 2],
								proposedAction: { kind: "chart", spec },
								generatedCode: null,
							},
						],
					}),
					usage,
				};
			},
		};
		let app = await startWorkbench({ dataDir: root, port: 0, assistantDriver: driver });
		try {
			let bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
			let headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
			const prefix = `/api/projects/${projectId}/datasets/${dataset.id}/assistant`;
			const otherPrefix = `/api/projects/${otherId}/datasets/${dataset.id}/assistant`;
			const request = (path: string, method = "GET", body?: unknown) =>
				fetch(`${app.url}${path}`, {
					method,
					headers,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
			const input = {
				provider: "fixture",
				modelId: "fixture-model",
				request: "compare failure rate by machine type over time",
				datasetVersionId: dataset.currentVersionId,
				selectedColumns: [0, 1, 2],
				filters: [],
			};
			assert.equal((await fetch(`${app.url}/api/assistant/models`)).status, 403);
			assert.equal((await request(`${otherPrefix}/prepare`, "POST", input)).status, 404);
			const prepared = await request(`${prefix}/prepare`, "POST", input);
			assert.equal(prepared.status, 201);
			approved = (await prepared.json()) as AssistantDraft;
			assert.equal(calls, 0);
			assert.equal(approved.context.rowsIncluded, false);
			assert.equal(
				(await request(`${prefix}/runs`, "POST", { draftId: approved.id, payloadHash: "tampered" })).status,
				409,
			);
			assert.equal(calls, 0);
			const started = await request(`${prefix}/runs`, "POST", {
				draftId: approved.id,
				payloadHash: approved.payloadHash,
			});
			assert.equal(started.status, 202);
			let run = (await started.json()) as AssistantRun;
			assert.equal(
				(await request(`${prefix}/runs`, "POST", { draftId: approved.id, payloadHash: approved.payloadHash }))
					.status,
				404,
			);
			for (let attempt = 0; run.state === "running" && attempt < 100; attempt++) {
				await delay(50);
				run = (await (await request(`${prefix}/runs/${run.id}`)).json()) as AssistantRun;
			}
			assert.equal(run.state, "completed", run.error ?? undefined);
			assert.equal(calls, 1);
			assert.deepEqual(run.usage, usage);
			assert.equal(run.suggestions[0].basis, "hypothesis");
			const suggestion = `${prefix}/runs/${run.id}/suggestions/compare-failure`;
			const otherRun = `${otherPrefix}/runs/${run.id}`;
			for (const [path, method, body] of [
				[`${otherPrefix}/runs`, "GET", undefined],
				[otherRun, "GET", undefined],
				[otherRun, "DELETE", undefined],
				[`${otherRun}/suggestions/compare-failure/status`, "POST", { status: "accepted" }],
				[`${otherRun}/suggestions/compare-failure/preview`, "POST", {}],
				[`${otherRun}/suggestions/compare-failure/apply`, "POST", { previewId: "forged" }],
				[`${otherRun}/suggestions/compare-failure/revert`, "POST", {}],
			] as const) {
				assert.equal((await request(path, method, body)).status, 404, path);
			}
			assert.equal((await request(`${suggestion}/status`, "POST", { status: "applied" })).status, 400);
			assert.equal((await request(`${suggestion}/apply`, "POST", { previewId: "forged" })).status, 409);
			assert.equal((await request(`${suggestion}/status`, "POST", { status: "accepted" })).status, 200);
			const previewResponse = await request(`${suggestion}/preview`, "POST", {});
			assert.equal(previewResponse.status, 200);
			const preview = (await previewResponse.json()) as { previewId: string; chart: { spec: unknown } };
			assert.deepEqual(preview.chart.spec, spec);
			assert.equal(calls, 1, "local preview must not send query rows back to provider");
			assert.deepEqual(await (await request(`/api/projects/${projectId}/datasets/${dataset.id}/charts`)).json(), []);
			const applied = await request(`${suggestion}/apply`, "POST", { previewId: preview.previewId });
			assert.equal(applied.status, 200);
			run = (await applied.json()) as AssistantRun;
			assert.equal(run.suggestions[0].status, "applied");
			assert.ok(run.suggestions[0].chartId);
			await app.close();
			app = await startWorkbench({ dataDir: root, port: 0, assistantDriver: driver });
			bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
			headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
			const restored = (await (await request(`${prefix}/runs/${run.id}`)).json()) as AssistantRun;
			assert.equal(restored.suggestions[0].status, "applied");
			const reverted = await request(`${suggestion}/revert`, "POST", {});
			assert.equal(reverted.status, 200);
			assert.equal(((await reverted.json()) as AssistantRun).suggestions[0].status, "reverted");
			assert.deepEqual(await (await request(`/api/projects/${projectId}/datasets/${dataset.id}/charts`)).json(), []);
			assert.deepEqual(await (await request(`/api/projects/${projectId}/datasets/${dataset.id}`)).json(), dataset);
		} finally {
			await app.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("credential HTTP rejects commands and never echoes submitted key material", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-assistant-auth-"));
	const app = await startWorkbench({ dataDir: root, port: 0 });
	try {
		const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
		const headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
		const secret = "!echo DO-NOT-ECHO-SECRET";
		const response = await fetch(`${app.url}/api/assistant/credentials`, {
			method: "POST",
			headers,
			body: JSON.stringify({ provider: "anthropic", apiKey: secret }),
		});
		assert.equal(response.status, 400);
		assert.doesNotMatch(await response.text(), /DO-NOT-ECHO-SECRET/);
		assert.equal(
			(
				await fetch(`${app.url}/api/assistant/credentials`, {
					method: "POST",
					headers: { ...headers, Origin: "https://hostile.invalid" },
					body: JSON.stringify({ provider: "anthropic", apiKey: "literal-test-key" }),
				})
			).status,
			403,
		);
		assert.equal((await fetch(`${app.url}/api/assistant/credentials`, { headers })).status, 404);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
