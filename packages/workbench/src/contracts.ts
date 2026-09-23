export const MAX_UPLOAD_BYTES = 100_000_000;
export const PAGE_SIZE = 100;
export const MAX_COLUMNS = 512;
export const MAX_RECORD_BYTES = 1_000_000;
export const PROFILE_VERSION = 1;

export interface Project {
	id: string;
	name: string;
	createdAt: string;
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

export interface Dataset {
	id: string;
	projectId: string;
	name: string;
	createdAt: string;
	byteSize: number;
	sha256: string;
	rowCount: number;
	columnCount: number;
	columns: ColumnProfile[];
	parsing: {
		encoding: "utf-8";
		delimiter: ",";
		header: true;
		emptyValues: "empty-string";
	};
	profileVersion: number;
	profiledAt: string;
}

export interface Preview {
	offset: number;
	limit: number;
	total: number;
	rows: string[][];
}

export interface ImportJob {
	id: string;
	projectId: string;
	name: string;
	kind: "import" | "reprofile";
	state: "uploading" | "processing" | "completed" | "cancelled" | "failed";
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
}
