import type { ColumnProfile, DatasetColumn, DatasetFormat, Preview } from "./contracts.ts";
import type { DatasetProfile, ProfileInput } from "./profile-contracts.ts";

export type AnalyticalRequest =
	| {
			kind: "ingest";
			sourcePath: string;
			artifactPath: string;
			tempPath: string;
			format: DatasetFormat;
			expectedSha256: string;
			expectedByteSize: number;
	  }
	| { kind: "preview"; artifactPath: string; tempPath: string; offset: number; limit: number; total: number }
	| { kind: "profile"; artifactPath: string; tempPath: string; input: ProfileInput };

export type AnalyticalResult =
	| {
			kind: "ingest";
			byteSize: number;
			sha256: string;
			rowCount: number;
			columns: ColumnProfile[];
			schema: DatasetColumn[];
			engineVersion: string;
	  }
	| { kind: "preview"; preview: Preview }
	| { kind: "profile"; profile: DatasetProfile };

// Curated protocol errors only. Native parser errors can contain source paths and cell contents.
export const ANALYTICAL_ERROR_MESSAGES = [
	"Dataset processing failed; check the file and available disk space.",
	"Analytical worker request is invalid.",
	"Source file does not match its recorded size and SHA-256 hash.",
	"Dataset exceeds the 100 MB upload limit.",
	"CSV must contain valid UTF-8 text.",
	"CSV is empty; a header row is required.",
	"CSV requires a nonempty header for every column.",
	"CSV column headers must be unique.",
	"Dataset cannot contain more than 512 columns.",
	"CSV is malformed; check quoting and consistent column counts.",
	"Dataset record exceeds the 1 MiB serialized size limit.",
	"Dataset exceeds the 256 MiB decoded output limit.",
	"Dataset schema exceeds the supported size or nesting limit.",
	"Parquet is malformed; check its signature, footer and data pages.",
	"Encrypted Parquet is not supported.",
	"Parquet footer exceeds the 16 MiB limit.",
	"Parquet metadata exceeds the declared decoded-size limits.",
	"Parquet contains unsupported timestamp or time precision; nanosecond UTC timestamps, nanosecond times and INT96 are not supported.",
	"Derived analytical data exceeds the 512 MiB storage limit.",
	"Analytical preview is invalid or its artifact is unavailable.",
	"Profile artifact does not match its recorded SHA-256 hash or schema.",
	"Profile exceeds the supported report size.",
] as const;

export type AnalyticalErrorMessage = (typeof ANALYTICAL_ERROR_MESSAGES)[number];
export type AnalyticalMessage =
	| { type: "progress"; bytesProcessed: number; rowCount: number }
	| { type: "result"; result: AnalyticalResult }
	| { type: "error"; error: AnalyticalErrorMessage };
