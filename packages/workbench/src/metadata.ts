import { DatabaseSync } from "node:sqlite";
import type { Dataset, ImportJob, Project } from "./contracts.ts";
import type { DatasetProfile } from "./profile-contracts.ts";

function decode<T>(row: Record<string, unknown> | undefined): T | undefined {
	if (!row) return undefined;
	if (typeof row.metadata !== "string") throw new Error("Invalid stored metadata.");
	return JSON.parse(row.metadata) as T;
}

/** Application metadata only; analytical rows stay in immutable DuckDB artifacts. */
export class MetadataStore {
	readonly #db: DatabaseSync;
	constructor(path: string) {
		this.#db = new DatabaseSync(path, { allowExtension: false });
		this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
		const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
		if (version !== 0 && version !== 1 && version !== 2) {
			this.#db.close();
			throw new Error("Unsupported application metadata version.");
		}
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, metadata TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS datasets (
				id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
				sha256 TEXT NOT NULL, format TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS datasets_project_hash ON datasets(project_id,sha256,format);
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
				state TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id,created_at);
			CREATE TABLE IF NOT EXISTS dataset_profiles (
				project_id TEXT NOT NULL REFERENCES projects(id),
				dataset_id TEXT NOT NULL REFERENCES datasets(id),
				dataset_version_id TEXT NOT NULL, artifact_sha256 TEXT NOT NULL,
				profiler_version INTEGER NOT NULL, metadata TEXT NOT NULL,
				PRIMARY KEY(project_id,dataset_id,dataset_version_id,artifact_sha256,profiler_version)
			);
			CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
			PRAGMA user_version=2;
		`);
	}
	get migrated(): boolean {
		return this.#db.prepare("SELECT name FROM migrations WHERE name='legacy-json'").get() !== undefined;
	}
	finishMigration(): void {
		this.#db.prepare("INSERT OR IGNORE INTO migrations(name) VALUES ('legacy-json')").run();
	}
	projects(): Project[] {
		return this.#db
			.prepare("SELECT metadata FROM projects ORDER BY created_at,id")
			.all()
			.map((row) => decode<Project>(row)!);
	}
	project(id: string): Project | undefined {
		return decode<Project>(this.#db.prepare("SELECT metadata FROM projects WHERE id=?").get(id));
	}
	putProject(project: Project): void {
		this.#db
			.prepare(
				"INSERT INTO projects(id,created_at,metadata) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
			)
			.run(project.id, project.createdAt, JSON.stringify(project));
	}
	datasets(projectId: string): Dataset[] {
		return this.#db
			.prepare("SELECT metadata FROM datasets WHERE project_id=? ORDER BY created_at,id")
			.all(projectId)
			.map((row) => decode<Dataset>(row)!);
	}
	dataset(projectId: string, id: string): Dataset | undefined {
		return decode<Dataset>(
			this.#db.prepare("SELECT metadata FROM datasets WHERE project_id=? AND id=?").get(projectId, id),
		);
	}
	duplicate(projectId: string, sha256: string, format: string): string | undefined {
		const row = this.#db
			.prepare("SELECT id FROM datasets WHERE project_id=? AND sha256=? AND format=? ORDER BY created_at,id LIMIT 1")
			.get(projectId, sha256, format);
		return typeof row?.id === "string" ? row.id : undefined;
	}
	putDataset(dataset: Dataset): void {
		this.#db
			.prepare(
				"INSERT INTO datasets(id,project_id,sha256,format,created_at,metadata) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
			)
			.run(
				dataset.id,
				dataset.projectId,
				dataset.sha256,
				dataset.format,
				dataset.createdAt,
				JSON.stringify(dataset),
			);
	}
	profile(
		projectId: string,
		datasetId: string,
		datasetVersionId: string,
		artifactSha256: string,
		profilerVersion: number,
	): DatasetProfile | undefined {
		return decode<DatasetProfile>(
			this.#db
				.prepare(
					"SELECT metadata FROM dataset_profiles WHERE project_id=? AND dataset_id=? AND dataset_version_id=? AND artifact_sha256=? AND profiler_version=?",
				)
				.get(projectId, datasetId, datasetVersionId, artifactSha256, profilerVersion),
		);
	}
	putProfile(projectId: string, datasetId: string, profile: DatasetProfile): void {
		this.#db
			.prepare(
				"INSERT INTO dataset_profiles(project_id,dataset_id,dataset_version_id,artifact_sha256,profiler_version,metadata) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,dataset_id,dataset_version_id,artifact_sha256,profiler_version) DO UPDATE SET metadata=excluded.metadata",
			)
			.run(
				projectId,
				datasetId,
				profile.datasetVersionId,
				profile.datasetVersionHash,
				profile.profilerVersion,
				JSON.stringify(profile),
			);
	}
	job(projectId: string, id: string): ImportJob | undefined {
		return decode<ImportJob>(
			this.#db.prepare("SELECT metadata FROM jobs WHERE project_id=? AND id=?").get(projectId, id),
		);
	}
	putJob(job: ImportJob): void {
		this.#db
			.prepare(
				"INSERT INTO jobs(id,project_id,state,created_at,metadata) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,metadata=excluded.metadata",
			)
			.run(job.id, job.projectId, job.state, job.createdAt, JSON.stringify(job));
	}
	recoverJobs(): void {
		this.transaction(() => {
			for (const row of this.#db
				.prepare("SELECT metadata FROM jobs WHERE state IN ('uploading','processing')")
				.all()) {
				const job = decode<ImportJob>(row)!;
				job.state = "failed";
				job.error =
					"The server stopped before this operation completed. Retry the import or recompute the profile.";
				job.updatedAt = new Date().toISOString();
				this.putJob(job);
			}
		});
	}
	pruneJobs(): void {
		this.#db.exec(
			"DELETE FROM jobs WHERE state NOT IN ('uploading','processing') AND id NOT IN (SELECT id FROM jobs ORDER BY created_at DESC,id DESC LIMIT 100)",
		);
	}
	transaction(action: () => void): void {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			action();
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}
	close(): void {
		this.#db.close();
	}
}
