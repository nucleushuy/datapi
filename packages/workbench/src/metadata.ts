import { DatabaseSync } from "node:sqlite";
import type { AssistantRun } from "./assistant-contracts.ts";
import type { ChartRecord } from "./chart-contracts.ts";
import type { Dataset, ImportJob, Project } from "./contracts.ts";
import type { Conversation } from "./conversation-contracts.ts";
import type { DatasetProfile } from "./profile-contracts.ts";
import type { TransformRecord } from "./transform-contracts.ts";

export interface TransformDraft {
	id: string;
	projectId: string;
	datasetId: string;
	outputVersionId: string;
	inputHash: string;
	outputHash: string;
	storageBytes: number;
	createdAt: string;
	expiresAt: string;
	revision: number;
}

export interface TransformTimeline {
	undo: string[];
	redo: string[];
	revision: number;
}

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
		if (
			version !== 0 &&
			version !== 1 &&
			version !== 2 &&
			version !== 3 &&
			version !== 4 &&
			version !== 5 &&
			version !== 6 &&
			version !== 7
		) {
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
			CREATE UNIQUE INDEX IF NOT EXISTS datasets_project_id ON datasets(project_id,id);
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
			CREATE TABLE IF NOT EXISTS charts (
				project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
				dataset_version_id TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL,
				PRIMARY KEY(project_id,dataset_id,id),
				FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id)
			);
			CREATE TABLE IF NOT EXISTS assistant_runs (
				project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
				created_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','completed','cancelled','failed')),
				metadata TEXT NOT NULL,
				PRIMARY KEY(project_id,dataset_id,id),
				FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id)
			);
			CREATE INDEX IF NOT EXISTS assistant_runs_history ON assistant_runs(project_id,dataset_id,created_at,id);
			CREATE TABLE IF NOT EXISTS assistant_conversations (
				project_id TEXT NOT NULL REFERENCES projects(id),
				dataset_id TEXT NOT NULL REFERENCES datasets(id),
				id TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				metadata TEXT NOT NULL,
				PRIMARY KEY(project_id,dataset_id,id)
			);
			CREATE INDEX IF NOT EXISTS assistant_conversations_history ON assistant_conversations(project_id,dataset_id,updated_at,id);
			CREATE TABLE IF NOT EXISTS transforms (
				project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
				created_at TEXT NOT NULL, state TEXT NOT NULL, metadata TEXT NOT NULL,
				PRIMARY KEY(project_id,dataset_id,id),
				FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id)
			);
			CREATE TABLE IF NOT EXISTS transform_drafts (
				project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
				metadata TEXT NOT NULL, PRIMARY KEY(project_id,dataset_id,id),
				FOREIGN KEY(project_id,dataset_id,id) REFERENCES transforms(project_id,dataset_id,id)
			);
			CREATE TABLE IF NOT EXISTS transform_timelines (
				project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, metadata TEXT NOT NULL,
				PRIMARY KEY(project_id,dataset_id),
				FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id)
			);
			CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
			PRAGMA user_version=7;
		`);
		if (version < 7) {
			for (const row of this.#db.prepare("SELECT metadata FROM assistant_conversations").all()) {
				const conversation = decode<Conversation>(row)!;
				conversation.title ??=
					conversation.messages.find((message) => message.role === "user")?.text.slice(0, 120) || "New chat";
				conversation.archivedAt ??= null;
				this.putConversation(conversation);
			}
		}
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
	charts(projectId: string, datasetId: string): ChartRecord[] {
		return this.#db
			.prepare("SELECT metadata FROM charts WHERE project_id=? AND dataset_id=? ORDER BY created_at,id")
			.all(projectId, datasetId)
			.map((row) => decode<ChartRecord>(row)!);
	}
	chart(projectId: string, datasetId: string, id: string): ChartRecord | undefined {
		return decode<ChartRecord>(
			this.#db
				.prepare("SELECT metadata FROM charts WHERE project_id=? AND dataset_id=? AND id=?")
				.get(projectId, datasetId, id),
		);
	}
	chartCount(projectId: string, datasetId: string): number {
		return Number(
			this.#db
				.prepare("SELECT COUNT(*) AS count FROM charts WHERE project_id=? AND dataset_id=?")
				.get(projectId, datasetId)?.count,
		);
	}
	putChart(chart: ChartRecord): void {
		this.#db
			.prepare(
				"INSERT INTO charts(project_id,dataset_id,id,dataset_version_id,created_at,metadata) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,dataset_id,id) DO UPDATE SET dataset_version_id=excluded.dataset_version_id,metadata=excluded.metadata",
			)
			.run(
				chart.projectId,
				chart.datasetId,
				chart.id,
				chart.spec.datasetVersionId,
				chart.createdAt,
				JSON.stringify(chart),
			);
	}
	deleteChart(projectId: string, datasetId: string, id: string): void {
		this.#db.prepare("DELETE FROM charts WHERE project_id=? AND dataset_id=? AND id=?").run(projectId, datasetId, id);
	}
	assistantRuns(projectId: string, datasetId: string): AssistantRun[] {
		return this.#db
			.prepare(
				"SELECT metadata FROM assistant_runs WHERE project_id=? AND dataset_id=? ORDER BY created_at DESC,id DESC",
			)
			.all(projectId, datasetId)
			.map((row) => decode<AssistantRun>(row)!);
	}
	assistantRun(projectId: string, datasetId: string, id: string): AssistantRun | undefined {
		return decode<AssistantRun>(
			this.#db
				.prepare("SELECT metadata FROM assistant_runs WHERE project_id=? AND dataset_id=? AND id=?")
				.get(projectId, datasetId, id),
		);
	}
	putAssistantRun(run: AssistantRun): void {
		this.#db
			.prepare(
				"INSERT INTO assistant_runs(project_id,dataset_id,id,created_at,state,metadata) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,dataset_id,id) DO UPDATE SET state=excluded.state,metadata=excluded.metadata",
			)
			.run(run.projectId, run.datasetId, run.id, run.createdAt, run.state, JSON.stringify(run));
	}
	assistantRunCount(projectId: string, datasetId: string): number {
		return Number(
			this.#db
				.prepare("SELECT COUNT(*) AS count FROM assistant_runs WHERE project_id=? AND dataset_id=?")
				.get(projectId, datasetId)?.count,
		);
	}
	pruneAssistantRuns(projectId: string, datasetId: string): void {
		this.#db
			.prepare(
				"DELETE FROM assistant_runs WHERE project_id=? AND dataset_id=? AND id IN (SELECT id FROM assistant_runs WHERE project_id=? AND dataset_id=? AND state<>'running' ORDER BY created_at,id LIMIT MAX(0,(SELECT COUNT(*) FROM assistant_runs WHERE project_id=? AND dataset_id=?)-99))",
			)
			.run(projectId, datasetId, projectId, datasetId, projectId, datasetId);
	}
	recoverAssistantRuns(): void {
		this.transaction(() => {
			for (const row of this.#db.prepare("SELECT metadata FROM assistant_runs WHERE state='running'").all()) {
				const run = decode<AssistantRun>(row)!;
				run.state = "failed";
				run.error =
					"The server stopped before this assistant run completed. Review and approve a new request to retry.";
				run.updatedAt = new Date().toISOString();
				this.putAssistantRun(run);
			}
		});
	}
	conversations(projectId: string, datasetId: string): Conversation[] {
		return this.#db
			.prepare(
				"SELECT metadata FROM assistant_conversations WHERE project_id=? AND dataset_id=? ORDER BY updated_at DESC,id DESC",
			)
			.all(projectId, datasetId)
			.map((row) => decode<Conversation>(row)!);
	}
	conversation(projectId: string, datasetId: string, id: string): Conversation | undefined {
		return decode<Conversation>(
			this.#db
				.prepare("SELECT metadata FROM assistant_conversations WHERE project_id=? AND dataset_id=? AND id=?")
				.get(projectId, datasetId, id),
		);
	}
	putConversation(conversation: Conversation): void {
		this.#db
			.prepare(
				"INSERT INTO assistant_conversations(project_id,dataset_id,id,updated_at,metadata) VALUES (?,?,?,?,?) ON CONFLICT(project_id,dataset_id,id) DO UPDATE SET updated_at=excluded.updated_at,metadata=excluded.metadata",
			)
			.run(
				conversation.projectId,
				conversation.datasetId,
				conversation.id,
				conversation.updatedAt,
				JSON.stringify(conversation),
			);
	}
	transforms(projectId: string, datasetId: string): TransformRecord[] {
		return this.#db
			.prepare("SELECT metadata FROM transforms WHERE project_id=? AND dataset_id=? ORDER BY created_at,id")
			.all(projectId, datasetId)
			.map((row) => decode<TransformRecord>(row)!);
	}
	transform(projectId: string, datasetId: string, id: string): TransformRecord | undefined {
		return decode<TransformRecord>(
			this.#db
				.prepare("SELECT metadata FROM transforms WHERE project_id=? AND dataset_id=? AND id=?")
				.get(projectId, datasetId, id),
		);
	}
	transformUsage(projectId: string, datasetId: string): { count: number; bytes: number } {
		const row = this.#db
			.prepare(
				"SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(metadata AS BLOB))),0) AS bytes FROM transforms WHERE project_id=? AND dataset_id=?",
			)
			.get(projectId, datasetId)!;
		return { count: Number(row.count), bytes: Number(row.bytes) };
	}
	putTransform(record: TransformRecord): void {
		this.#db
			.prepare(
				"INSERT INTO transforms(project_id,dataset_id,id,created_at,state,metadata) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,dataset_id,id) DO UPDATE SET state=excluded.state,metadata=excluded.metadata",
			)
			.run(record.projectId, record.datasetId, record.id, record.createdAt, record.state, JSON.stringify(record));
	}
	transformDrafts(): TransformDraft[] {
		return this.#db
			.prepare("SELECT metadata FROM transform_drafts")
			.all()
			.map((row) => decode<TransformDraft>(row)!);
	}
	transformDraft(projectId: string, datasetId: string, id: string): TransformDraft | undefined {
		return decode<TransformDraft>(
			this.#db
				.prepare("SELECT metadata FROM transform_drafts WHERE project_id=? AND dataset_id=? AND id=?")
				.get(projectId, datasetId, id),
		);
	}
	putTransformDraft(draft: TransformDraft): void {
		this.#db
			.prepare("INSERT INTO transform_drafts(project_id,dataset_id,id,metadata) VALUES (?,?,?,?)")
			.run(draft.projectId, draft.datasetId, draft.id, JSON.stringify(draft));
	}
	deleteTransformDraft(projectId: string, datasetId: string, id: string): void {
		this.#db
			.prepare("DELETE FROM transform_drafts WHERE project_id=? AND dataset_id=? AND id=?")
			.run(projectId, datasetId, id);
	}
	transformTimeline(projectId: string, datasetId: string): TransformTimeline {
		return (
			decode<TransformTimeline>(
				this.#db
					.prepare("SELECT metadata FROM transform_timelines WHERE project_id=? AND dataset_id=?")
					.get(projectId, datasetId),
			) ?? { undo: [], redo: [], revision: 0 }
		);
	}
	putTransformTimeline(projectId: string, datasetId: string, timeline: TransformTimeline): void {
		this.#db
			.prepare(
				"INSERT INTO transform_timelines(project_id,dataset_id,metadata) VALUES (?,?,?) ON CONFLICT(project_id,dataset_id) DO UPDATE SET metadata=excluded.metadata",
			)
			.run(projectId, datasetId, JSON.stringify(timeline));
	}
	recoverTransforms(): void {
		this.transaction(() => {
			for (const row of this.#db
				.prepare(
					"SELECT metadata FROM transforms WHERE state='previewed' AND NOT EXISTS (SELECT 1 FROM transform_drafts WHERE transform_drafts.project_id=transforms.project_id AND transform_drafts.dataset_id=transforms.dataset_id AND transform_drafts.id=transforms.id)",
				)
				.all()) {
				const record = decode<TransformRecord>(row)!;
				record.state = "failed";
				record.completedAt = new Date().toISOString();
				record.error = "The server stopped before this transformation completed. Preview again before approving.";
				this.putTransform(record);
			}
		});
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
