import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, Dataset, ImportJob, Preview, Project } from "../src/contracts.ts";
import { MAX_DECODED_BYTES, MAX_PREVIEW_ROWS, MAX_UPLOAD_BYTES } from "../src/contracts.ts";
import { startWorkbench } from "../src/server.ts";
import { parquetFixture } from "./fixtures.ts";

async function waitForJob(url: string, token: string, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const response = await fetch(`${url}/api/projects/${projectId}/imports/${id}`, {
			headers: { "X-Workbench-Token": token },
		});
		assert.equal(response.status, 200);
		const job = (await response.json()) as ImportJob;
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		await delay(25);
	}
	throw new Error("Import did not settle within 120 seconds.");
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

async function httpFixture(
	context: TestContext,
): Promise<{ dataDir: string; url: string; token: string; headers: Record<string, string> }> {
	const dataDir = await mkdtemp(join(tmpdir(), "datapi-http-ingestion-"));
	const app = await startWorkbench({ dataDir, port: 0 });
	context.after(async () => {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
	return {
		dataDir,
		url: app.url,
		token: bootstrap.token,
		headers: { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" },
	};
}

async function createProject(url: string, headers: Record<string, string>, name: string): Promise<Project> {
	const response = await fetch(`${url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name }) });
	assert.equal(response.status, 201);
	return (await response.json()) as Project;
}

async function reserveImport(
	url: string,
	headers: Record<string, string>,
	projectId: string,
	name: string,
	mimeType?: string,
): Promise<ImportJob> {
	const response = await fetch(`${url}/api/projects/${projectId}/imports`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name, mimeType }),
	});
	assert.equal(response.status, 201);
	return (await response.json()) as ImportJob;
}

test(
	"HTTP workflow persists projects, original CSV profiles and paginated preview across restart",
	{ timeout: 120_000 },
	async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "datapi-http-"));
		let app = await startWorkbench({ dataDir, port: 0 });
		try {
			const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
			assert.deepEqual(bootstrap.projects, []);
			assert.equal(bootstrap.maxUploadBytes, MAX_UPLOAD_BYTES);
			assert.equal(bootstrap.maxPreviewRows, MAX_PREVIEW_ROWS);
			assert.equal(bootstrap.maxDecodedBytes, MAX_DECODED_BYTES);
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
			const uploaded = await fetch(`${app.url}/api/projects/${project.id}/imports/${importJob.id}/content`, {
				method: "PUT",
				headers: { ...headers, "Content-Type": "text/csv" },
				body: source,
			});
			assert.equal(uploaded.status, 202);
			const job = await waitForJob(app.url, bootstrap.token, project.id, importJob.id);
			assert.equal(job.state, "completed", job.error);
			const datasetUrl = `/api/projects/${project.id}/datasets/${job.datasetId}`;
			const dataset = (await (await fetch(`${app.url}${datasetUrl}`, { headers })).json()) as Dataset;
			assert.equal(dataset.rowCount, 105);
			assert.equal(dataset.columnCount, 3);
			assert.equal(dataset.format, "csv");
			assert.equal(dataset.originalFilename, "observations.csv");
			assert.deepEqual(await readFile(join(dataDir, dataset.storageLocation)), Buffer.from(source));
			assert.equal(dataset.columns[1].emptyCount, 1);
			assert.equal(dataset.columns[1].numericCount, 104);
			assert.equal(dataset.columns[1].max, 102);
			const first = (await (await fetch(`${app.url}${datasetUrl}/preview?offset=0`, { headers })).json()) as Preview;
			assert.equal(first.rows.length, 100);
			assert.deepEqual(first.rows[0], ["001", "3", "two\nlines"]);
			assert.equal(first.rows[1][2], "<script>alert(1)</script>");
			const last = (await (
				await fetch(`${app.url}${datasetUrl}/preview?offset=100`, { headers })
			).json()) as Preview;
			assert.equal(last.rows.length, 5);
			for (const query of [
				"offset=1.5",
				"offset=9007199254740992",
				"limit=0",
				"limit=501",
				"limit=1.5",
				"limit=-1",
			]) {
				assert.equal((await fetch(`${app.url}${datasetUrl}/preview?${query}`, { headers })).status, 400, query);
			}
			const limited = (await (
				await fetch(`${app.url}${datasetUrl}/preview?offset=1&limit=25`, { headers })
			).json()) as Preview;
			assert.equal(limited.limit, 25);
			assert.equal(limited.rows.length, 25);
			assert.deepEqual(limited.rows[0], ["002", "", "<script>alert(1)</script>"]);
			assert.equal((await fetch(`${app.url}${datasetUrl}/preview?offset=-1`, { headers })).status, 400);
			const recompute = (await (
				await fetch(`${app.url}${datasetUrl}/reprofile`, { method: "POST", headers })
			).json()) as ImportJob;
			assert.equal((await waitForJob(app.url, bootstrap.token, project.id, recompute.id)).state, "completed");
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
			assert.equal(restored.sourceVersionId, dataset.sourceVersionId);
			assert.notEqual(restored.currentVersionId, dataset.currentVersionId);
			assert.equal(restored.versions.length, dataset.versions.length + 1);
			const durableJob = await fetch(`${app.url}/api/projects/${project.id}/imports/${job.id}`, {
				headers: { "X-Workbench-Token": reopened.token },
			});
			assert.equal(durableJob.status, 200);
			assert.deepEqual(await durableJob.json(), job);
		} finally {
			await app.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	},
);

test(
	"local HTTP boundary rejects cross-origin, forged Host, missing token and unsafe input",
	{ timeout: 120_000 },
	async () => {
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
						body: JSON.stringify({ name: "x".repeat(32_769) }),
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
					await fetch(`${app.url}/api/projects/${project.id}/imports/${reservation.id}/content`, {
						method: "PUT",
						headers: { ...headers, "Content-Type": "text/csv" },
						body: 'name,value\n"private cell,5',
					})
				).status,
				202,
			);
			const failed = await waitForJob(app.url, bootstrap.token, project.id, reservation.id);
			assert.equal(failed.state, "failed");
			assert.doesNotMatch(failed.error ?? "", /private cell/);
			assert.deepEqual(
				await (await fetch(`${app.url}/api/projects/${project.id}/datasets`, { headers })).json(),
				[],
			);
			const next = (await (
				await fetch(`${app.url}/api/projects/${project.id}/imports`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: "cancel.csv" }),
				})
			).json()) as ImportJob;
			const cancelled = await fetch(`${app.url}/api/projects/${project.id}/imports/${next.id}`, {
				method: "DELETE",
				headers,
			});
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
					`${app.url}/api/projects/${project.id}/imports/${oversized.id}/content`,
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
				(
					(await (
						await fetch(`${app.url}/api/projects/${project.id}/imports/${oversized.id}`, { headers })
					).json()) as ImportJob
				).state,
				"uploading",
			);
			await fetch(`${app.url}/api/projects/${project.id}/imports/${oversized.id}`, { method: "DELETE", headers });
		} finally {
			await app.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	},
);

test(
	"cancelling an active HTTP upload releases the import slot without publishing a dataset",
	{ timeout: 120_000 },
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
			const upload = httpRequest(`${app.url}/api/projects/${project.id}/imports/${job.id}/content`, {
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
						await fetch(`${app.url}/api/projects/${project.id}/imports/${job.id}`, { headers })
					).json()) as ImportJob;
					if (progress.bytesReceived > 0) {
						received = true;
						break;
					}
					await delay(10);
				}
				assert.equal(received, true);
				const cancelled = (await (
					await fetch(`${app.url}/api/projects/${project.id}/imports/${job.id}`, { method: "DELETE", headers })
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

test("HTTP metadata accepts exactly 32 KiB and rejects one byte more", { timeout: 120_000 }, async (context) => {
	const { url, headers } = await httpFixture(context);
	const metadata = JSON.stringify({
		name: "Metadata boundary",
		description: "Field notes",
		settings: { previewRowLimit: 25 },
	});
	const body = metadata + " ".repeat(32_768 - Buffer.byteLength(metadata));
	assert.equal(Buffer.byteLength(body), 32_768);
	const accepted = await fetch(`${url}/api/projects`, { method: "POST", headers, body });
	assert.equal(accepted.status, 201);
	const project = (await accepted.json()) as Project;
	assert.equal(project.description, "Field notes");
	assert.deepEqual(project.settings, { previewRowLimit: 25 });
	assert.equal((await fetch(`${url}/api/projects`, { method: "POST", headers, body: `${body} ` })).status, 413);
	assert.equal(((await (await fetch(`${url}/api/projects`, { headers })).json()) as Project[]).length, 1);
});

test(
	"HTTP Parquet ingestion preserves exact strings, nulls and project-scoped duplicate provenance",
	{ timeout: 120_000 },
	async (context) => {
		const { dataDir, url, token, headers } = await httpFixture(context);
		const firstProject = await createProject(url, headers, "Parquet study");
		const otherProject = await createProject(url, headers, "Independent study");
		const source = await parquetFixture(context);
		const datasets: Dataset[] = [];
		for (const projectId of [firstProject.id, firstProject.id, otherProject.id]) {
			const reservation = await reserveImport(
				url,
				headers,
				projectId,
				"exact.parquet",
				"application/vnd.apache.parquet",
			);
			assert.equal(reservation.format, "parquet");
			const uploaded = await fetch(`${url}/api/projects/${projectId}/imports/${reservation.id}/content`, {
				method: "PUT",
				headers: { ...headers, "Content-Type": "application/octet-stream" },
				body: new Uint8Array(source),
			});
			assert.equal(uploaded.status, 202);
			const job = await waitForJob(url, token, projectId, reservation.id);
			assert.equal(job.state, "completed", job.error);
			assert.ok(job.datasetId);
			const response = await fetch(`${url}/api/projects/${projectId}/datasets/${job.datasetId}`, { headers });
			assert.equal(response.status, 200);
			datasets.push((await response.json()) as Dataset);
		}
		const [first, duplicate, separate] = datasets;
		assert.equal(first.format, "parquet");
		assert.equal(first.duplicateOf, undefined);
		assert.equal(duplicate.duplicateOf, first.id);
		assert.equal(separate.duplicateOf, undefined);
		assert.equal(separate.sha256, first.sha256);
		assert.notEqual(duplicate.id, first.id);
		assert.notEqual(separate.id, first.id);
		assert.notEqual(duplicate.storageLocation, first.storageLocation);
		assert.notEqual(separate.storageLocation, first.storageLocation);
		assert.deepEqual(await readFile(join(dataDir, first.storageLocation)), source);
		assert.deepEqual(
			first.schema.slice(0, 3).map((column) => column.sourceType),
			["BIGINT", "UBIGINT", "DECIMAL(38,18)"],
		);
		const previewUrl = `${url}/api/projects/${firstProject.id}/datasets/${first.id}/preview`;
		const preview = (await (await fetch(`${previewUrl}?offset=0&limit=1`, { headers })).json()) as Preview;
		assert.deepEqual(preview, {
			offset: 0,
			limit: 1,
			total: 2,
			rows: [
				[
					"9007199254740993",
					"18446744073709551615",
					"12345678901234567890.123456789012345678",
					"2026-09-23",
					"2026-09-23 12:34:56.123456",
					"true",
					"",
					"[1, 2]",
				],
			],
		});
		const nulls = (await (await fetch(`${previewUrl}?offset=1&limit=500`, { headers })).json()) as Preview;
		assert.deepEqual(nulls.rows, [Array.from({ length: 8 }, () => null)]);
		const listed = (await (
			await fetch(`${url}/api/projects/${otherProject.id}/datasets`, { headers })
		).json()) as Dataset[];
		assert.deepEqual(
			listed.map((dataset) => dataset.id),
			[separate.id],
		);
	},
);

test(
	"every HTTP dataset and job endpoint rejects cross-project access without changing the owning resource",
	{ timeout: 120_000 },
	async (context) => {
		const { url, token, headers } = await httpFixture(context);
		const owner = await createProject(url, headers, "Owner project");
		const other = await createProject(url, headers, "Other project");
		const completedReservation = await reserveImport(url, headers, owner.id, "private.csv");
		assert.equal(
			(
				await fetch(`${url}/api/projects/${owner.id}/imports/${completedReservation.id}/content`, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "text/csv" },
					body: "x\nprivate-value\n",
				})
			).status,
			202,
		);
		const completed = await waitForJob(url, token, owner.id, completedReservation.id);
		assert.equal(completed.state, "completed", completed.error);
		assert.ok(completed.datasetId);
		const datasetPath = `/api/projects/${owner.id}/datasets/${completed.datasetId}`;
		const before = (await (await fetch(`${url}${datasetPath}`, { headers })).json()) as Dataset;
		for (const [suffix, method] of [
			["", "GET"],
			["/preview", "GET"],
			["/reprofile", "POST"],
		]) {
			const response: Response = await fetch(
				`${url}/api/projects/${other.id}/datasets/${completed.datasetId}${suffix}`,
				{
					method,
					headers,
				},
			);
			assert.equal(response.status, 404, `${method} dataset${suffix}`);
			assert.doesNotMatch(await response.text(), /private-value|private\.csv/);
		}
		const reservation = await reserveImport(url, headers, owner.id, "private-upload.csv");
		for (const job of [reservation, completed]) {
			const protectedPath = `/api/projects/${other.id}/imports/${job.id}`;
			for (const [suffix, method] of [
				["", "GET"],
				["", "DELETE"],
				["/retry", "POST"],
				["/content", "PUT"],
			]) {
				const response = await fetch(`${url}${protectedPath}${suffix}`, {
					method,
					headers: { ...headers, "Content-Type": "text/csv" },
					...(method === "PUT" ? { body: "x\nattacker\n" } : {}),
				});
				assert.equal(response.status, 404, `${method} ${job.state} job${suffix}`);
				assert.doesNotMatch(await response.text(), /private-upload|private\.csv/);
			}
		}
		// The unscoped job API is removed, not an alias that bypasses project ownership.
		for (const [suffix, method] of [
			["", "GET"],
			["", "DELETE"],
			["/retry", "POST"],
			["/content", "PUT"],
		]) {
			assert.equal(
				(
					await fetch(`${url}/api/imports/${reservation.id}${suffix}`, {
						method,
						headers,
						...(method === "PUT" ? { body: "x\nattacker\n" } : {}),
					})
				).status,
				404,
			);
		}
		const unchanged = (await (
			await fetch(`${url}/api/projects/${owner.id}/imports/${reservation.id}`, { headers })
		).json()) as ImportJob;
		assert.deepEqual(unchanged, reservation);
		assert.deepEqual(
			await (await fetch(`${url}/api/projects/${owner.id}/imports/${completed.id}`, { headers })).json(),
			completed,
		);
		assert.equal(
			(await fetch(`${url}/api/projects/${owner.id}/imports/${reservation.id}`, { method: "DELETE", headers }))
				.status,
			200,
		);
		assert.deepEqual(await (await fetch(`${url}${datasetPath}`, { headers })).json(), before);
		assert.deepEqual(((await (await fetch(`${url}${datasetPath}/preview`, { headers })).json()) as Preview).rows, [
			["private-value"],
		]);
		assert.deepEqual(await (await fetch(`${url}/api/projects/${other.id}/datasets`, { headers })).json(), []);
	},
);

test(
	"HTTP retry reserves a fresh upload, retains the failed job and enforces extension, MIME and signatures",
	{ timeout: 120_000 },
	async (context) => {
		const { url, token, headers } = await httpFixture(context);
		const project = await createProject(url, headers, "Retry project");
		const importsUrl = `${url}/api/projects/${project.id}/imports`;
		for (const input of [
			{ name: "data.json" },
			{ name: "data.csv", mimeType: "application/parquet" },
			{ name: "data.parquet", mimeType: "text/csv" },
		]) {
			assert.equal((await fetch(importsUrl, { method: "POST", headers, body: JSON.stringify(input) })).status, 415);
		}
		const original = await reserveImport(url, headers, project.id, "retry.parquet");
		const contentUrl = `${importsUrl}/${original.id}/content`;
		assert.equal(
			(
				await fetch(contentUrl, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "text/csv" },
					body: "x\n1\n",
				})
			).status,
			415,
		);
		assert.equal(
			((await (await fetch(`${importsUrl}/${original.id}`, { headers })).json()) as ImportJob).bytesReceived,
			0,
		);
		assert.equal(
			(
				await fetch(contentUrl, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "application/parquet" },
					body: "x\nprivate-invalid-parquet\n",
				})
			).status,
			202,
		);
		const failed = await waitForJob(url, token, project.id, original.id);
		assert.equal(failed.state, "failed");
		assert.doesNotMatch(failed.error ?? "", /private-invalid/);
		const retryResponse = await fetch(`${importsUrl}/${original.id}/retry`, { method: "POST", headers });
		assert.equal(retryResponse.status, 201);
		const retry = (await retryResponse.json()) as ImportJob;
		assert.notEqual(retry.id, original.id);
		assert.equal(retry.retryOf, original.id);
		assert.equal(retry.state, "uploading");
		assert.equal(retry.format, "parquet");
		assert.equal(retry.name, original.name);
		assert.equal(retry.bytesReceived, 0);
		assert.equal(retry.bytesProcessed, 0);
		assert.equal(retry.datasetId, undefined);
		assert.equal((await fetch(`${importsUrl}/${retry.id}/retry`, { method: "POST", headers })).status, 409);
		assert.deepEqual(await (await fetch(`${url}/api/projects/${project.id}/datasets`, { headers })).json(), []);
		const source = await parquetFixture(context);
		assert.equal(
			(
				await fetch(contentUrl, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "application/parquet" },
					body: new Uint8Array(source),
				})
			).status,
			409,
		);
		assert.equal(
			(
				await fetch(`${importsUrl}/${retry.id}/content`, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "application/parquet" },
					body: new Uint8Array(source),
				})
			).status,
			202,
		);
		const completed = await waitForJob(url, token, project.id, retry.id);
		assert.equal(completed.state, "completed", completed.error);
		assert.ok(completed.datasetId);
		assert.deepEqual(await (await fetch(`${importsUrl}/${failed.id}`, { headers })).json(), failed);
		assert.equal((await fetch(`${importsUrl}/${completed.id}/retry`, { method: "POST", headers })).status, 409);
		const cancelled = await reserveImport(url, headers, project.id, "cancelled.csv");
		assert.equal((await fetch(`${importsUrl}/${cancelled.id}`, { method: "DELETE", headers })).status, 200);
		const retryCancelled = await fetch(`${importsUrl}/${cancelled.id}/retry`, { method: "POST", headers });
		assert.equal(retryCancelled.status, 201);
		const fresh = (await retryCancelled.json()) as ImportJob;
		assert.notEqual(fresh.id, cancelled.id);
		assert.equal(fresh.retryOf, cancelled.id);
		assert.equal(fresh.bytesReceived, 0);
		assert.equal((await fetch(`${importsUrl}/${fresh.id}`, { method: "DELETE", headers })).status, 200);
	},
);
