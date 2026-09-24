import type { TransformSpec } from "./transform-contracts.ts";

export const MAX_UPLOAD_BYTES = 100_000_000;
export const PAGE_SIZE = 100;
export const MAX_PREVIEW_ROWS = 500;
export const MAX_COLUMNS = 512;
export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
export const MAX_PARQUET_FOOTER_BYTES = 16 * 1024 * 1024;
export const MAX_PARQUET_ROW_GROUP_BYTES = 64 * 1024 * 1024;
export const MAX_TEMP_BYTES = 512 * 1024 * 1024;
export const WORKER_MEMORY_BYTES = 1024 * 1024 * 1024;
export const PROCESSING_TIMEOUT_MS = 5 * 60_000;
export const PROFILE_VERSION = 1;
export const SCHEMA_VERSION = 2;

export type DatasetFormat = "csv" | "parquet";

export interface ProjectSettings {
	previewRowLimit: number;
}

export interface Project {
	id: string;
	ownerId: null;
	name: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	settings: ProjectSettings;
}

export interface ColumnProfile {
	index: number;
	name: string;
	inferredType: "empty" | "number" | "boolean" | "text";
	emptyCount: number;
	numericCount: number;
	min: number | null;
	max: number | null;
}

export interface DatasetColumn {
	index: number;
	name: string;
	sourceType: string;
	basicType: "empty" | "number" | "boolean" | "text" | "datetime" | "binary" | "nested";
}

export interface DatasetVersionFacts {
	rowCount: number;
	schema: DatasetColumn[];
	columns: ColumnProfile[];
	profileVersion: number;
	profiledAt: string;
	artifactSha256: string;
}

export interface DatasetVersion {
	id: string;
	kind: "source" | "derived";
	parentVersionId: string | null;
	storageLocation: string;
	createdAt: string;
	operation:
		| { kind: "upload" | "ingest"; engine: string; version: string }
		| { kind: "transform"; engine: string; version: string; spec: TransformSpec; recordId: string };
	/** Absent only on uploaded source bytes and legacy metadata before initialization upgrades it. */
	facts?: DatasetVersionFacts;
}

export interface Dataset {
	id: string;
	projectId: string;
	name: string;
	originalFilename: string;
	format: DatasetFormat;
	createdAt: string;
	updatedAt: string;
	byteSize: number;
	sha256: string;
	rowCount: number;
	columnCount: number;
	ingestionStatus: "ready";
	schemaVersion: 2;
	storageLocation: string;
	sourceVersionId: string;
	currentVersionId: string;
	versions: DatasetVersion[];
	schema: DatasetColumn[];
	duplicateOf?: string;
	columns: ColumnProfile[];
	parsing:
		| { format: "csv"; encoding: "utf-8"; delimiter: ","; header: true; emptyValues: "empty-string" }
		| { format: "parquet"; emptyValues: "null"; valueEncoding: "duckdb-text" };
	profileVersion: number;
	profiledAt: string;
}

export interface Preview {
	offset: number;
	limit: number;
	total: number;
	rows: (string | null)[][];
}

export interface ImportJob {
	id: string;
	projectId: string;
	name: string;
	format: DatasetFormat;
	kind: "import" | "reprofile" | "profile";
	state: "uploading" | "processing" | "completed" | "cancelled" | "failed";
	createdAt: string;
	updatedAt: string;
	retryOf?: string;
	bytesReceived: number;
	bytesProcessed: number;
	rowCount: number;
	datasetId?: string;
	error?: string;
}

export interface Bootstrap {
	token: string;
	projects: Project[];
	maxUploadBytes: number;
	maxPreviewRows: number;
	maxDecodedBytes: number;
}
