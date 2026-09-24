import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bootstrap, Dataset, ImportJob, Project } from "../src/contracts.ts";
import { PROFILE_SAMPLE_ROWS, PROFILER_VERSION, type ProfileResponse } from "../src/profile-contracts.ts";
import { startWorkbench } from "../src/server.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "workbench-profile-"));
	const state = { root, store: new WorkbenchStore(root) };
	context.after(async () => {
		await state.store.close();
		await rm(root, { recursive: true, force: true });
	});
	await state.store.init();
	const project = await state.store.createProject("Profile fixtures");
	return { state, projectId: project.id };
}

async function* bytes(source: string): AsyncGenerator<Uint8Array> {
	const buffer = Buffer.from(source);
	for (let offset = 0; offset < buffer.length; offset += 16 * 1024) yield buffer.subarray(offset, offset + 16 * 1024);
}

async function waitJob(store: WorkbenchStore, projectId: string, id: string): Promise<ImportJob> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const job = store.getJob(projectId, id);
		if (["completed", "failed", "cancelled"].includes(job.state)) return job;
		assert.equal(job.kind === "profile" ? job.bytesProcessed : 0, 0);
		await delay(10);
	}
	throw new Error("Profile fixture job did not settle within 120 seconds.");
}

async function imported(
	store: WorkbenchStore,
	projectId: string,
	source = "id,value\n001,1\n002,2\n003,3\n",
): Promise<Dataset> {
	const job = await store.createImport(projectId, "private.csv");
	assert.equal((await store.upload(projectId, job.id, bytes(source))).state, "processing");
	const completed = await waitJob(store, projectId, job.id);
	assert.equal(completed.state, "completed", completed.error);
	assert.ok(completed.datasetId);
	return store.getDataset(projectId, completed.datasetId);
}

function status(expected: number): (error: unknown) => boolean {
	return (error) => error instanceof WorkbenchError && error.status === expected;
}

function artifact(root: string, dataset: Dataset): string {
	const current = dataset.versions.find((version) => version.id === dataset.currentVersionId);
	assert.ok(current);
	return join(root, current.storageLocation);
}

test(
	"profile jobs sample rows, preserve originals and lineage, and reuse durable cache across restart",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const source = `id,value,category\n${Array.from({ length: 5000 }, (_, index) => `${index % 20},${index % 10},private-category-${index % 2}\n`).join("")}`;
		const original = await imported(state.store, projectId, source);
		const beforeArtifact = await readFile(artifact(state.root, original));
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		const started = await state.store.profile(projectId, original.id);
		assert.equal(started.kind, "profile");
		assert.equal(started.state, "processing");
		assert.equal(started.datasetId, original.id);
		assert.equal(started.bytesReceived, 0);
		assert.equal(started.bytesProcessed, 0);
		const completed = await waitJob(state.store, projectId, started.id);
		assert.equal(completed.state, "completed", completed.error);
		const profile = await state.store.getProfile(projectId, original.id);
		assert.ok(profile);
		assert.equal(profile.profilerVersion, PROFILER_VERSION);
		assert.equal(profile.datasetVersionId, original.currentVersionId);
		assert.equal(profile.datasetVersionHash, createHash("sha256").update(beforeArtifact).digest("hex"));
		assert.notEqual(profile.datasetVersionHash, original.sha256);
		assert.equal(profile.rowCount, 5000);
		assert.equal(profile.columnCount, 3);
		assert.equal(profile.sourceBytes, Buffer.byteLength(source));
		assert.equal(profile.storageBytes, beforeArtifact.length);
		assert.equal(profile.sampling.method, "systematic");
		assert.equal(profile.sampling.approximate, true);
		assert.ok(profile.sampling.sampleSize > 0 && profile.sampling.sampleSize <= PROFILE_SAMPLE_ROWS);
		assert.equal(completed.rowCount, profile.sampling.sampleSize);
		assert.equal(completed.bytesProcessed, 0);
		assert.ok(profile.duplicateCount > 0);
		assert.doesNotMatch(JSON.stringify(profile), /private-category-/);
		assert.deepEqual(await state.store.getDataset(projectId, original.id), original);
		assert.deepEqual(await readFile(artifact(state.root, original)), beforeArtifact);
		assert.deepEqual(await readFile(join(state.root, original.storageLocation)), Buffer.from(source));
		const cached = await state.store.profile(projectId, original.id);
		assert.equal(cached.state, "completed");
		assert.notEqual(cached.id, started.id);
		assert.equal(cached.rowCount, profile.sampling.sampleSize);
		assert.deepEqual(await state.store.getProfile(projectId, original.id), profile);
		await state.store.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.deepEqual(state.store.getJob(projectId, completed.id), completed);
		assert.deepEqual(state.store.getJob(projectId, cached.id), cached);
		assert.deepEqual(await state.store.getProfile(projectId, original.id), profile);
		assert.equal((await state.store.profile(projectId, original.id)).state, "completed");
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		const reprofile = await state.store.reprofile(projectId, original.id);
		assert.equal((await waitJob(state.store, projectId, reprofile.id)).state, "completed");
		const nextVersion = await state.store.getDataset(projectId, original.id);
		assert.notEqual(nextVersion.currentVersionId, original.currentVersionId);
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		const refreshed = await state.store.profile(projectId, original.id);
		assert.equal(refreshed.state, "processing");
		assert.equal((await waitJob(state.store, projectId, refreshed.id)).state, "completed");
		assert.equal(
			(await state.store.getProfile(projectId, original.id))?.datasetVersionId,
			nextVersion.currentVersionId,
		);
		assert.deepEqual(await state.store.getDataset(projectId, original.id), nextVersion);
	},
);

test(
	"profile cancellation, owner scope, admission and shutdown never publish incomplete cache",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const original = await imported(state.store, projectId);
		const other = await state.store.createProject("Other owner");
		await assert.rejects(state.store.getProfile(other.id, original.id), status(404));
		await assert.rejects(state.store.profile(other.id, original.id), status(404));
		const outcomes = await Promise.allSettled([
			state.store.profile(projectId, original.id),
			state.store.profile(projectId, original.id),
		]);
		assert.equal(outcomes[0].status, "fulfilled");
		assert.equal(outcomes[1].status, "rejected");
		if (outcomes[0].status !== "fulfilled" || outcomes[1].status !== "rejected")
			throw new Error("Expected admission conflict.");
		assert.ok(status(409)(outcomes[1].reason));
		const started = outcomes[0].value;
		assert.throws(() => state.store.getJob(other.id, started.id), status(404));
		await assert.rejects(state.store.cancel(other.id, started.id), status(404));
		const cancelled = await state.store.cancel(projectId, started.id);
		assert.equal(cancelled.state, "cancelled");
		assert.equal(cancelled.bytesProcessed, 0);
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		await assert.rejects(state.store.retryImport(projectId, started.id), /Start the dataset profile again/);
		assert.deepEqual(await state.store.getDataset(projectId, original.id), original);
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		// Reads remain available during an active reservation, but do not create a worker or cache.
		const reservation = await state.store.createImport(projectId, "pending.csv");
		assert.deepEqual(
			await Promise.all([
				state.store.getProfile(projectId, original.id),
				state.store.getProfile(projectId, original.id),
			]),
			[null, null],
		);
		await state.store.cancel(projectId, reservation.id);
		const interrupted = await state.store.profile(projectId, original.id);
		await state.store.close();
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.equal(state.store.getJob(projectId, interrupted.id).state, "cancelled");
		assert.deepEqual(state.store.getJob(projectId, cancelled.id), cancelled);
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		assert.deepEqual(await state.store.getDataset(projectId, original.id), original);
	},
);

test(
	"profile cache invalidates profiler changes and artifact hashes and failed workers retain immutable metadata",
	{ timeout: 120_000 },
	async (context) => {
		const { state, projectId } = await fixture(context);
		const original = await imported(state.store, projectId);
		const started = await state.store.profile(projectId, original.id);
		assert.equal((await waitJob(state.store, projectId, started.id)).state, "completed");
		const profile = await state.store.getProfile(projectId, original.id);
		assert.ok(profile);
		await state.store.close();
		const database = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			database
				.prepare("UPDATE dataset_profiles SET profiler_version=? WHERE project_id=? AND dataset_id=?")
				.run(PROFILER_VERSION + 1, projectId, original.id);
		} finally {
			database.close();
		}
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		const recomputed = await state.store.profile(projectId, original.id);
		assert.equal(recomputed.state, "processing");
		assert.equal((await waitJob(state.store, projectId, recomputed.id)).state, "completed");
		const valid = await state.store.getProfile(projectId, original.id);
		assert.ok(valid);
		const path = artifact(state.root, original);
		const originalArtifact = await readFile(path);
		const corrupted = Buffer.from(originalArtifact);
		corrupted.fill(0, 0, 16);
		await writeFile(path, corrupted);
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		const damaged = await state.store.profile(projectId, original.id);
		const failed = await waitJob(state.store, projectId, damaged.id);
		assert.equal(failed.state, "failed");
		assert.equal(failed.bytesProcessed, 0);
		assert.doesNotMatch(failed.error ?? "", /private\.csv|001|002|003|SELECT|duckdb/i);
		assert.equal(await state.store.getProfile(projectId, original.id), null);
		assert.deepEqual(await state.store.getDataset(projectId, original.id), original);
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
		await writeFile(path, originalArtifact);
		assert.deepEqual(await state.store.getProfile(projectId, original.id), valid);
		await state.store.close();
		const interrupted: ImportJob = {
			...damaged,
			id: randomUUID(),
			state: "processing",
			rowCount: 2,
			bytesProcessed: 0,
		};
		const recovery = new DatabaseSync(join(state.root, "workbench.sqlite"));
		try {
			recovery
				.prepare("INSERT INTO jobs(id,project_id,state,created_at,metadata) VALUES (?,?,?,?,?)")
				.run(interrupted.id, projectId, interrupted.state, interrupted.createdAt, JSON.stringify(interrupted));
		} finally {
			recovery.close();
		}
		await mkdir(join(state.root, "staging", interrupted.id));
		await writeFile(join(state.root, "staging", interrupted.id, "partial.json"), "unfinished");
		state.store = new WorkbenchStore(state.root);
		await state.store.init();
		const recovered = state.store.getJob(projectId, interrupted.id);
		assert.equal(recovered.kind, "profile");
		assert.equal(recovered.state, "failed");
		assert.equal(recovered.rowCount, 2);
		assert.equal(recovered.bytesProcessed, 0);
		assert.match(recovered.error ?? "", /stopped/);
		assert.deepEqual(await state.store.getProfile(projectId, original.id), valid);
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
	},
);

test("profile artifact path rejects symlinks before hashing", { timeout: 120_000 }, async (context) => {
	const { state, projectId } = await fixture(context);
	const dataset = await imported(state.store, projectId);
	const path = artifact(state.root, dataset);
	const backup = `${path}.regular`;
	await rename(path, backup);
	try {
		try {
			await symlink(backup, path);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			if (code === "EPERM" || code === "EACCES") {
				context.skip("Platform does not permit test symlinks.");
				return;
			}
			throw error;
		}
		await assert.rejects(state.store.getProfile(projectId, dataset.id), status(409));
		await assert.rejects(state.store.profile(projectId, dataset.id), status(409));
		assert.deepEqual(await state.store.getDataset(projectId, dataset.id), dataset);
		assert.deepEqual(await readdir(join(state.root, "staging")), []);
	} finally {
		await rm(path, { force: true });
		await rename(backup, path);
	}
});

test(
	"profile HTTP endpoints require session and project scope, ignore client hashes, and return completed cache jobs",
	{ timeout: 120_000 },
	async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "workbench-profile-http-"));
		const app = await startWorkbench({ dataDir, port: 0 });
		try {
			const bootstrap = (await (await fetch(`${app.url}/api/bootstrap`)).json()) as Bootstrap;
			const headers = { "X-Workbench-Token": bootstrap.token, "Content-Type": "application/json" };
			const createProject = async (name: string): Promise<Project> => {
				const response = await fetch(`${app.url}/api/projects`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name }),
				});
				assert.equal(response.status, 201);
				return (await response.json()) as Project;
			};
			const owner = await createProject("Owner");
			const other = await createProject("Other");
			const importResponse = await fetch(`${app.url}/api/projects/${owner.id}/imports`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "private.csv" }),
			});
			assert.equal(importResponse.status, 201);
			const reservation = (await importResponse.json()) as ImportJob;
			assert.equal(
				(
					await fetch(`${app.url}/api/projects/${owner.id}/imports/${reservation.id}/content`, {
						method: "PUT",
						headers: { ...headers, "Content-Type": "text/csv" },
						body: "id,value\n1,private-value\n2,another-private\n",
					})
				).status,
				202,
			);
			const waitHttp = async (id: string): Promise<ImportJob> => {
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					const response = await fetch(`${app.url}/api/projects/${owner.id}/imports/${id}`, { headers });
					assert.equal(response.status, 200);
					const job = (await response.json()) as ImportJob;
					if (["completed", "failed", "cancelled"].includes(job.state)) return job;
					await delay(25);
				}
				throw new Error("HTTP profile job did not settle.");
			};
			const importedJob = await waitHttp(reservation.id);
			assert.equal(importedJob.state, "completed", importedJob.error);
			assert.ok(importedJob.datasetId);
			const path = `/api/projects/${owner.id}/datasets/${importedJob.datasetId}/profile`;
			for (const method of ["GET", "POST"]) {
				assert.equal((await fetch(`${app.url}${path}`, { method })).status, 403);
				const response: Response = await fetch(
					`${app.url}/api/projects/${other.id}/datasets/${importedJob.datasetId}/profile`,
					{ method, headers },
				);
				assert.equal(response.status, 404);
				assert.doesNotMatch(await response.text(), /private/);
			}
			const empty = await fetch(`${app.url}${path}`, { headers });
			assert.equal(empty.status, 200);
			assert.deepEqual(await empty.json(), { profile: null });
			const startedResponse = await fetch(`${app.url}${path}?datasetVersionHash=untrusted`, {
				method: "POST",
				headers,
				body: JSON.stringify({ datasetVersionHash: "0".repeat(64) }),
			});
			assert.equal(startedResponse.status, 202);
			const started = (await startedResponse.json()) as ImportJob;
			assert.equal(started.kind, "profile");
			assert.equal(started.bytesProcessed, 0);
			for (const method of ["GET", "DELETE"]) {
				const response = await fetch(`${app.url}/api/projects/${other.id}/imports/${started.id}`, {
					method,
					headers,
				});
				assert.equal(response.status, 404);
			}
			const completed = await waitHttp(started.id);
			assert.equal(completed.state, "completed", completed.error);
			assert.equal(completed.rowCount, 2);
			const reportResponse = await fetch(`${app.url}${path}`, { headers });
			assert.equal(reportResponse.status, 200);
			const report = (await reportResponse.json()) as ProfileResponse;
			assert.ok(report.profile);
			assert.match(report.profile.datasetVersionHash, /^[a-f0-9]{64}$/);
			assert.notEqual(report.profile.datasetVersionHash, "0".repeat(64));
			assert.doesNotMatch(JSON.stringify(report), /private-value|another-private/);
			const cachedResponse = await fetch(`${app.url}${path}`, { method: "POST", headers });
			assert.equal(cachedResponse.status, 202);
			const cached = (await cachedResponse.json()) as ImportJob;
			assert.equal(cached.state, "completed");
			assert.equal(cached.kind, "profile");
			assert.notEqual(cached.id, started.id);
			const retry = await fetch(`${app.url}/api/projects/${owner.id}/imports/${cached.id}/retry`, {
				method: "POST",
				headers,
			});
			assert.equal(retry.status, 409);
			assert.match(await retry.text(), /Start the dataset profile again/);
		} finally {
			await app.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	},
);
