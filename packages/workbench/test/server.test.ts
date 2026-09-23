import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, Dataset, ImportJob, Preview, Project } from "../src/contracts.ts";
import { MAX_UPLOAD_BYTES } from "../src/contracts.ts";
import { startWorkbench } from "../src/server.ts";

async function waitForJob(url: string, token: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const response = await fetch(`${url}/api/imports/${id}`, { headers: { "X-Workbench-Token": token } });
		assert.equal(response.status, 200);
		const job = (await response.json()) as ImportJob;
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(10);
	}
	throw new Error("Import did not settle.");
}

async function httpStatus(url: string, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(url, { headers }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.on("error", reject);
		request.end();
	});
}

test("HTTP workflow persists projects, original CSV profiles and paginated preview across restart", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "datapi-http-"));
	let app = await startWorkbench({ dataDir, port: 0 });
	try {
		const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
		assert.deepEqual(bootstrap.projects, []);
		assert.equal(bootstrap.maxUploadBytes, MAX_UPLOAD_BYTES);
		const headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
		const created = await fetch(`${app.url}/api/projects`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Field study" }),
		});
		assert.equal(created.status, 201);
		const project = (await created.json()) as Project;
		const reservation = await fetch(`${app.url}/api/projects/${project.id}/imports`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "observations.csv" }),
		});
		assert.equal(reservation.status, 201);
		const importJob = (await reservation.json()) as ImportJob;
		const source =
			'\ufeffid,value,note\r\n001,3,"two\nlines"\r\n002,,<script>alert(1)</script>\r\n' +
			Array.from({ length: 103 }, (_, index) => `${index + 3},${index},plain\r\n`).join("");
		const uploaded = await fetch(`${app.url}/api/imports/${importJob.id}/content`, {
			method: "PUT",
			headers: { ...headers, "Content-Type": "text/csv" },
			body: source,
		});
		assert.equal(uploaded.status, 202);
		const job = await waitForJob(app.url, bootstrap.token, importJob.id);
		assert.equal(job.state, "completed", job.error);
		const datasetUrl = `/api/projects/${project.id}/datasets/${job.datasetId}`;
		const dataset = (await (await fetch(`${app.url}${datasetUrl}`, { headers })).json()) as Dataset;
		assert.equal(dataset.rowCount, 105);
		assert.equal(dataset.columnCount, 3);
		assert.equal(dataset.columns[1].emptyCount, 1);
		assert.equal(dataset.columns[1].numericCount, 104);
		assert.equal(dataset.columns[1].max, 102);
		const first = (await (await fetch(`${app.url}${datasetUrl}/preview?offset=0`, { headers })).json()) as Preview;
		assert.equal(first.rows.length, 100);
		assert.deepEqual(first.rows[0], ["001", "3", "two\nlines"]);
		assert.equal(first.rows[1][2], "<script>alert(1)</script>");
		const last = (await (await fetch(`${app.url}${datasetUrl}/preview?offset=100`, { headers })).json()) as Preview;
		assert.equal(last.rows.length, 5);
		assert.equal((await fetch(`${app.url}${datasetUrl}/preview?offset=-1`, { headers })).status, 400);
		const recompute = (await (
			await fetch(`${app.url}${datasetUrl}/reprofile`, { method: "POST", headers })
		).json()) as ImportJob;
		assert.equal((await waitForJob(app.url, bootstrap.token, recompute.id)).state, "completed");
		await app.close();
		app = await startWorkbench({ dataDir, port: 0 });
		assert.equal((await fetch(`${app.url}/api/projects`, { headers })).status, 403);
		const reopened = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
		assert.deepEqual(reopened.projects, [project]);
		const restored = (await (
			await fetch(`${app.url}${datasetUrl}`, { headers: { "X-Workbench-Token": reopened.token } })
		).json()) as Dataset;
		assert.deepEqual(restored.columns, dataset.columns);
		assert.equal(restored.sha256, dataset.sha256);
	} finally {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});

test("local HTTP boundary rejects cross-origin, forged Host, missing token and unsafe input", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "datapi-security-"));
	const app = await startWorkbench({ dataDir, port: 0 });
	try {
		const root = await fetch(app.url);
		assert.equal(root.status, 200);
		assert.match(root.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.equal(root.headers.get("cache-control"), "no-store");
		assert.equal(root.headers.get("access-control-allow-origin"), null);
		assert.equal(
			(await fetch(`${app.url}/api/bootstrap`, { headers: { Origin: "https://attacker.example" } })).status,
			403,
		);
		assert.equal(await httpStatus(`${app.url}/api/bootstrap`, { Host: "attacker.example" }), 403);
		assert.equal(await httpStatus(`${app.url}/api/bootstrap`, { "Sec-Fetch-Site": "cross-site" }), 403);
		assert.equal((await fetch(`${app.url}/api/projects`)).status, 403);
		const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
		const headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
		assert.equal((await fetch(`${app.url}/api/projects`, { method: "POST", headers, body: "{" })).status, 400);
		assert.equal(
			(await fetch(`${app.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: " " }) }))
				.status,
			400,
		);
		assert.equal(
			(
				await fetch(`${app.url}/api/projects`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: "x".repeat(5000) }),
				})
			).status,
			413,
		);
		assert.equal((await fetch(`${app.url}/api/projects/not-an-id/datasets`, { headers })).status, 400);
		const project = (await (
			await fetch(`${app.url}/api/projects`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "Safe project" }),
			})
		).json()) as Project;
		const reservation = (await (
			await fetch(`${app.url}/api/projects/${project.id}/imports`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "broken.csv" }),
			})
		).json()) as ImportJob;
		assert.equal(
			(
				await fetch(`${app.url}/api/imports/${reservation.id}/content`, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "text/csv" },
					body: 'name,value\n"private cell,5',
				})
			).status,
			202,
		);
		const failed = await waitForJob(app.url, bootstrap.token, reservation.id);
		assert.equal(failed.state, "failed");
		assert.doesNotMatch(failed.error ?? "", /private cell/);
		assert.deepEqual(await (await fetch(`${app.url}/api/projects/${project.id}/datasets`, { headers })).json(), []);
		const next = (await (
			await fetch(`${app.url}/api/projects/${project.id}/imports`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "cancel.csv" }),
			})
		).json()) as ImportJob;
		const cancelled = await fetch(`${app.url}/api/imports/${next.id}`, { method: "DELETE", headers });
		assert.equal(((await cancelled.json()) as ImportJob).state, "cancelled");
		const oversized = (await (
			await fetch(`${app.url}/api/projects/${project.id}/imports`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "too-large.csv" }),
			})
		).json()) as ImportJob;
		const oversizedStatus = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				`${app.url}/api/imports/${oversized.id}/content`,
				{
					method: "PUT",
					headers: { ...headers, "Content-Type": "text/csv", "Content-Length": String(MAX_UPLOAD_BYTES + 1) },
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			request.on("error", reject);
			request.end();
		});
		assert.equal(oversizedStatus, 413);
		assert.equal(
			((await (await fetch(`${app.url}/api/imports/${oversized.id}`, { headers })).json()) as ImportJob).state,
			"uploading",
		);
		await fetch(`${app.url}/api/imports/${oversized.id}`, { method: "DELETE", headers });
	} finally {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});

test(
	"cancelling an active HTTP upload releases the import slot without publishing a dataset",
	{ timeout: 15_000 },
	async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "datapi-cancel-"));
		const app = await startWorkbench({ dataDir, port: 0 });
		try {
			const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
			const headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
			const project = (await (
				await fetch(`${app.url}/api/projects`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: "Cancellation" }),
				})
			).json()) as Project;
			const job = (await (
				await fetch(`${app.url}/api/projects/${project.id}/imports`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: "stream.csv" }),
				})
			).json()) as ImportJob;
			const upload = httpRequest(`${app.url}/api/imports/${job.id}/content`, {
				method: "PUT",
				headers: { ...headers, "Content-Type": "text/csv", "Transfer-Encoding": "chunked" },
			});
			// A cancelled request may be closed by the server before the client ends its body.
			upload.on("error", () => {});
			upload.on("response", (response) => response.resume());
			try {
				upload.write("name,value\nfirst,1\n");
				const deadline = Date.now() + 5000;
				let received = false;
				while (Date.now() < deadline) {
					const progress = (await (
						await fetch(`${app.url}/api/imports/${job.id}`, { headers })
					).json()) as ImportJob;
					if (progress.bytesReceived > 0) {
						received = true;
						break;
					}
					await delay(10);
				}
				assert.equal(received, true);
				const cancelled = (await (
					await fetch(`${app.url}/api/imports/${job.id}`, { method: "DELETE", headers })
				).json()) as ImportJob;
				assert.equal(cancelled.state, "cancelled");
				const next = await fetch(`${app.url}/api/projects/${project.id}/imports`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: "next.csv" }),
				});
				assert.equal(next.status, 201);
				assert.deepEqual(
					await (await fetch(`${app.url}/api/projects/${project.id}/datasets`, { headers })).json(),
					[],
				);
			} finally {
				upload.destroy();
			}
		} finally {
			await app.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	},
);
