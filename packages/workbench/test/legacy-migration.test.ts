import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PAGE_SIZE, PROFILE_VERSION, SCHEMA_VERSION } from "../src/contracts.ts";
import { WorkbenchError, WorkbenchStore } from "../src/storage.ts";
import { legacyFixture } from "./fixtures.ts";

test(
	"legacy JSON migration preserves project and dataset identity, source bytes and lineage across restart",
	{ timeout: 120_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "datapi-legacy-"));
		let store = new WorkbenchStore(root);
		try {
			const fixture = await legacyFixture(root);
			const paths = [
				fixture.projectPath,
				fixture.metadataPath,
				fixture.sourcePath,
				fixture.rowsPath,
				fixture.indexPath,
			];
			const originals = await Promise.all(paths.map((path) => readFile(path)));
			await store.init();
			const projects = await store.listProjects();
			assert.deepEqual(projects, [
				{
					...fixture.project,
					ownerId: null,
					description: "",
					updatedAt: fixture.project.createdAt,
					settings: { previewRowLimit: PAGE_SIZE },
				},
			]);
			const dataset = await store.getDataset(fixture.project.id, fixture.dataset.id);
			assert.equal(dataset.id, fixture.dataset.id);
			assert.equal(dataset.projectId, fixture.project.id);
			assert.equal(dataset.createdAt, fixture.dataset.createdAt);
			assert.equal(dataset.name, fixture.dataset.name);
			assert.equal(dataset.originalFilename, fixture.dataset.name);
			assert.equal(dataset.sha256, fixture.dataset.sha256);
			assert.equal(dataset.byteSize, fixture.dataset.byteSize);
			assert.equal(dataset.format, "csv");
			assert.equal(dataset.ingestionStatus, "ready");
			assert.equal(dataset.schemaVersion, SCHEMA_VERSION);
			assert.equal(dataset.profileVersion, PROFILE_VERSION);
			assert.equal(dataset.rowCount, fixture.dataset.rowCount);
			assert.equal(dataset.columnCount, fixture.dataset.columnCount);
			assert.deepEqual(dataset.columns, fixture.dataset.columns);
			assert.equal(resolve(root, dataset.storageLocation), fixture.sourcePath);
			assert.equal(dataset.versions.length, 2);
			const source = dataset.versions.find((version) => version.id === dataset.sourceVersionId);
			const derived = dataset.versions.find((version) => version.id === dataset.currentVersionId);
			assert.ok(source && derived);
			assert.equal(source.kind, "source");
			assert.equal(source.storageLocation, dataset.storageLocation);
			assert.equal(source.parentVersionId, null);
			assert.equal(derived.kind, "derived");
			assert.equal(derived.parentVersionId, source.id);
			assert.notEqual(derived.storageLocation, source.storageLocation);
			assert.ok((await readFile(join(root, derived.storageLocation))).length > 0);
			assert.deepEqual((await store.preview(fixture.project.id, fixture.dataset.id, 0)).rows, [["001"], ["-2"]]);
			assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), originals);
			assert.deepEqual(await readdir(join(root, "staging")), []);
			await store.close();
			const database = new DatabaseSync(join(root, "workbench.sqlite"), { readOnly: true });
			try {
				assert.equal(
					database.prepare("SELECT name FROM migrations WHERE name='legacy-json'").get()?.name,
					"legacy-json",
				);
				assert.equal(database.prepare("SELECT count(*) AS count FROM projects").get()?.count, 1);
				assert.equal(database.prepare("SELECT count(*) AS count FROM datasets").get()?.count, 1);
			} finally {
				database.close();
			}
			store = new WorkbenchStore(root);
			await store.init();
			assert.deepEqual(await store.listProjects(), projects);
			assert.deepEqual(await store.listDatasets(fixture.project.id), [dataset]);
			assert.deepEqual((await store.preview(fixture.project.id, fixture.dataset.id, 0)).rows, [["001"], ["-2"]]);
			assert.deepEqual(await readdir(join(dirname(fixture.sourcePath), "versions")), [derived.id]);
			assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), originals);
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("legacy projects without a datasets directory migrate without inventing datasets", async () => {
	const root = await mkdtemp(join(tmpdir(), "datapi-empty-legacy-"));
	const store = new WorkbenchStore(root);
	try {
		const project = { id: randomUUID(), name: "Empty legacy project", createdAt: "2024-01-02T03:04:05.000Z" };
		const directory = join(root, "projects", project.id);
		await mkdir(directory, { recursive: true });
		const source = JSON.stringify(project);
		await writeFile(join(directory, "project.json"), source);
		await store.init();
		assert.equal((await store.listProjects())[0].id, project.id);
		assert.deepEqual(await store.listDatasets(project.id), []);
		assert.equal(await readFile(join(directory, "project.json"), "utf8"), source);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

for (const failure of ["hash mismatch", "malformed CSV", "invalid dataset JSON"] as const) {
	test(
		`failed legacy migration (${failure}) preserves every original file and can resume after repair`,
		{ timeout: 120_000 },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "datapi-failed-legacy-"));
			let store = new WorkbenchStore(root);
			try {
				const fixture = await legacyFixture(root);
				const originalMetadata = await readFile(fixture.metadataPath);
				const originalSource = await readFile(fixture.sourcePath);
				if (failure === "hash mismatch") {
					await writeFile(fixture.sourcePath, "x\n999\n-2\n");
				} else if (failure === "malformed CSV") {
					// A valid hash ensures this failure reaches the real CSV parser, not only the integrity gate.
					const source = Buffer.from('x\n"private broken\n');
					await writeFile(fixture.sourcePath, source);
					await writeFile(
						fixture.metadataPath,
						JSON.stringify({
							...fixture.dataset,
							byteSize: source.length,
							sha256: createHash("sha256").update(source).digest("hex"),
						}),
					);
				} else {
					await writeFile(fixture.metadataPath, "{private invalid JSON");
				}
				const paths = [
					fixture.projectPath,
					fixture.metadataPath,
					fixture.sourcePath,
					fixture.rowsPath,
					fixture.indexPath,
				];
				const originals = await Promise.all(paths.map((path) => readFile(path)));
				for (let attempt = 0; attempt < 2; attempt++) {
					await assert.rejects(store.init(), (error: unknown) => {
						assert.ok(error instanceof WorkbenchError);
						assert.equal(error.status, 500);
						assert.doesNotMatch(error.message, /private/);
						assert.ok(!error.message.includes(root));
						return true;
					});
					await store.close();
					assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), originals);
					assert.deepEqual(await readdir(join(root, "staging")), []);
					const database = new DatabaseSync(join(root, "workbench.sqlite"), { readOnly: true });
					try {
						assert.equal(
							database.prepare("SELECT name FROM migrations WHERE name='legacy-json'").get(),
							undefined,
						);
						assert.equal(
							database.prepare("SELECT id FROM datasets WHERE id=?").get(fixture.dataset.id),
							undefined,
						);
					} finally {
						database.close();
					}
					store = new WorkbenchStore(root);
				}
				await writeFile(fixture.metadataPath, originalMetadata);
				await writeFile(fixture.sourcePath, originalSource);
				await store.init();
				const migrated = await store.getDataset(fixture.project.id, fixture.dataset.id);
				assert.equal(migrated.sha256, fixture.dataset.sha256);
				assert.equal(migrated.versions.length, 2);
				assert.deepEqual((await store.preview(fixture.project.id, fixture.dataset.id, 0)).rows, [["001"], ["-2"]]);
			} finally {
				await store.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}
