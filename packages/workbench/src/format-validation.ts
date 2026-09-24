import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AnalyticalErrorMessage, AnalyticalRequest } from "./analytical-contracts.ts";
import { parseChartSpec } from "./chart-spec.ts";
import {
	MAX_DECODED_BYTES,
	MAX_PARQUET_FOOTER_BYTES,
	MAX_PREVIEW_ROWS,
	MAX_RECORD_BYTES,
	MAX_UPLOAD_BYTES,
} from "./contracts.ts";
import { isProfileInput } from "./profile-validation.ts";

export class FormatValidationError extends Error {
	constructor(message: AnalyticalErrorMessage) {
		super(message);
		this.name = "FormatValidationError";
	}
}

export function fail(message: AnalyticalErrorMessage): never {
	throw new FormatValidationError(message);
}

export function sqlString(value: string): string {
	if (value.includes("\0")) fail("Analytical worker request is invalid.");
	return `'${value.replaceAll("'", "''")}'`;
}

export function sqlIdentifier(value: string): string {
	if (value.includes("\0")) fail("Dataset schema exceeds the supported size or nesting limit.");
	return `"${value.replaceAll('"', '""')}"`;
}

function localPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		isAbsolute(value) &&
		!/[\u0000-\u001f*?[\]]/u.test(value) &&
		!value.startsWith("\\\\") &&
		!value.startsWith("//")
	);
}

export function parseAnalyticalRequest(value: unknown): AnalyticalRequest {
	if (!value || typeof value !== "object") fail("Analytical worker request is invalid.");
	const request = value as Record<string, unknown>;
	if (!localPath(request.artifactPath) || !localPath(request.tempPath)) fail("Analytical worker request is invalid.");
	if (request.kind === "chart") {
		if (!isProfileInput(request.input)) fail("Analytical worker request is invalid.");
		try {
			return {
				kind: "chart",
				artifactPath: resolve(request.artifactPath),
				tempPath: resolve(request.tempPath),
				input: request.input,
				spec: parseChartSpec(request.spec, request.input.schema, request.input.datasetVersionId),
			};
		} catch {
			fail("Chart specification is invalid for this dataset version.");
		}
	}
	if (request.kind === "profile") {
		if (!isProfileInput(request.input)) fail("Analytical worker request is invalid.");
		return {
			kind: "profile",
			artifactPath: resolve(request.artifactPath),
			tempPath: resolve(request.tempPath),
			input: request.input,
		};
	}
	if (request.kind === "preview") {
		if (
			!Number.isSafeInteger(request.offset) ||
			typeof request.offset !== "number" ||
			request.offset < 0 ||
			!Number.isSafeInteger(request.total) ||
			typeof request.total !== "number" ||
			request.total < 0 ||
			!Number.isInteger(request.limit) ||
			typeof request.limit !== "number" ||
			request.limit < 1 ||
			request.limit > MAX_PREVIEW_ROWS
		)
			fail("Analytical worker request is invalid.");
		return {
			kind: "preview",
			artifactPath: resolve(request.artifactPath),
			tempPath: resolve(request.tempPath),
			offset: request.offset,
			limit: request.limit,
			total: request.total,
		};
	}
	if (
		request.kind !== "ingest" ||
		!localPath(request.sourcePath) ||
		(request.format !== "csv" && request.format !== "parquet") ||
		typeof request.expectedSha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(request.expectedSha256) ||
		typeof request.expectedByteSize !== "number" ||
		!Number.isSafeInteger(request.expectedByteSize) ||
		request.expectedByteSize < 0 ||
		resolve(request.sourcePath).toLowerCase() === resolve(request.artifactPath).toLowerCase()
	)
		fail("Analytical worker request is invalid.");
	return {
		kind: "ingest",
		sourcePath: resolve(request.sourcePath),
		artifactPath: resolve(request.artifactPath),
		tempPath: resolve(request.tempPath),
		format: request.format,
		expectedSha256: request.expectedSha256,
		expectedByteSize: request.expectedByteSize,
	};
}

export async function verifySource(request: Extract<AnalyticalRequest, { kind: "ingest" }>): Promise<void> {
	const info = await lstat(request.sourcePath);
	if (!info.isFile() || info.isSymbolicLink()) fail("Source file does not match its recorded size and SHA-256 hash.");
	if (info.size > MAX_UPLOAD_BYTES || request.expectedByteSize > MAX_UPLOAD_BYTES)
		fail("Dataset exceeds the 100 MB upload limit.");
	if (info.size !== request.expectedByteSize) fail("Source file does not match its recorded size and SHA-256 hash.");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(request.sourcePath, { highWaterMark: 64 * 1024 })) {
		bytes += chunk.length;
		if (bytes > MAX_UPLOAD_BYTES) fail("Dataset exceeds the 100 MB upload limit.");
		hash.update(chunk);
	}
	if (bytes !== request.expectedByteSize || hash.digest("hex") !== request.expectedSha256) {
		fail("Source file does not match its recorded size and SHA-256 hash.");
	}
}

export async function validateParquetEnvelope(path: string, byteSize: number): Promise<number> {
	if (byteSize < 12) fail("Parquet is malformed; check its signature, footer and data pages.");
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(4);
		const footer = Buffer.alloc(8);
		const first = await file.read(header, 0, 4, 0);
		const last = await file.read(footer, 0, 8, byteSize - 8);
		if (header.toString("ascii") === "PARE" || footer.subarray(4).toString("ascii") === "PARE") {
			fail("Encrypted Parquet is not supported.");
		}
		if (
			first.bytesRead !== 4 ||
			last.bytesRead !== 8 ||
			header.toString("ascii") !== "PAR1" ||
			footer.subarray(4).toString("ascii") !== "PAR1"
		) {
			fail("Parquet is malformed; check its signature, footer and data pages.");
		}
		const footerBytes = footer.readUInt32LE(0);
		if (footerBytes > MAX_PARQUET_FOOTER_BYTES) fail("Parquet footer exceeds the 16 MiB limit.");
		if (footerBytes === 0 || footerBytes > byteSize - 12)
			fail("Parquet is malformed; check its signature, footer and data pages.");
		return byteSize - footerBytes - 8;
	} finally {
		await file.close();
	}
}

export function validateParquetPrecision(physicalType: string | null, logicalType: string | null): void {
	const nanos = logicalType?.includes("NANOS=NanoSeconds(") ?? false;
	if (
		physicalType === "INT96" ||
		(nanos &&
			(logicalType?.startsWith("TimeType(") ||
				(logicalType?.startsWith("TimestampType(") && /isAdjustedToUTC=(?:1|true)(?:,|\))/u.test(logicalType))))
	) {
		fail(
			"Parquet contains unsupported timestamp or time precision; nanosecond UTC timestamps, nanosecond times and INT96 are not supported.",
		);
	}
}

// This measures serialized output, not allocations inside a decoder. The process job limit is the native backstop.
export class DecodedBudget {
	#bytes = 0;
	add(row: readonly (string | null)[]): number {
		const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
		if (bytes > MAX_RECORD_BYTES) fail("Dataset record exceeds the 1 MiB serialized size limit.");
		this.#bytes += bytes;
		if (this.#bytes > MAX_DECODED_BYTES) fail("Dataset exceeds the 256 MiB decoded output limit.");
		return bytes;
	}
}
