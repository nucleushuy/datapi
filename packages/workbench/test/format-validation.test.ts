import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_DECODED_BYTES, MAX_PARQUET_FOOTER_BYTES, MAX_RECORD_BYTES } from "../src/contracts.ts";
import {
	DecodedBudget,
	parseAnalyticalRequest,
	sqlIdentifier,
	sqlString,
	validateParquetEnvelope,
	validateParquetPrecision,
	verifySource,
} from "../src/format-validation.ts";

test("decoded budgets count JSON escaping and reject one byte beyond each limit", () => {
	const exactRow = ["x".repeat(MAX_RECORD_BYTES - 5)];
	assert.equal(new DecodedBudget().add(exactRow), MAX_RECORD_BYTES);
	assert.throws(() => new DecodedBudget().add([`${exactRow[0]}x`]), /1 MiB/);
	assert.throws(() => new DecodedBudget().add(["\u0001".repeat(Math.ceil(MAX_RECORD_BYTES / 6))]), /1 MiB/);
	const budget = new DecodedBudget();
	for (let bytes = 0; bytes < MAX_DECODED_BYTES; bytes += MAX_RECORD_BYTES) budget.add(exactRow);
	assert.throws(() => budget.add([]), /256 MiB/);
});

test("request validation rejects remote paths, globs, invalid limits and source overwrite", () => {
	const root = join(tmpdir(), "datapi-validation");
	const preview = {
		kind: "preview",
		artifactPath: join(root, "data.duckdb"),
		tempPath: join(root, "temp"),
		offset: 0,
		limit: 25,
		total: 1,
	};
	assert.deepEqual(parseAnalyticalRequest(preview), preview);
	for (const artifactPath of [
		"relative.duckdb",
		"//server/share/data",
		"\\\\server\\share\\data",
		join(root, "*.duckdb"),
		`${root}\0`,
	]) {
		assert.throws(() => parseAnalyticalRequest({ ...preview, artifactPath }), /request is invalid/);
	}
	for (const limit of [0, 501, 1.5, Infinity])
		assert.throws(() => parseAnalyticalRequest({ ...preview, limit }), /request is invalid/);
	assert.throws(
		() => parseAnalyticalRequest({ ...preview, offset: Number.MAX_SAFE_INTEGER + 1 }),
		/request is invalid/,
	);
	assert.throws(
		() =>
			parseAnalyticalRequest({
				...preview,
				kind: "ingest",
				format: "csv",
				sourcePath: preview.artifactPath,
				expectedByteSize: 1,
				expectedSha256: "a".repeat(64),
			}),
		/request is invalid/,
	);
	assert.equal(sqlString("a'b"), "'a''b'");
	assert.equal(sqlIdentifier('a"b'), '"a""b"');
	assert.throws(() => sqlString("a\0b"), /request is invalid/);
});

test("Parquet envelope rejects encryption, oversized or invalid footer and truncated magic", async () => {
	const root = await mkdtemp(join(tmpdir(), "datapi-envelope-"));
	const path = join(root, "source.parquet");
	try {
		const envelope = Buffer.alloc(16);
		envelope.write("PAR1");
		envelope.writeUInt32LE(4, 8);
		envelope.write("PAR1", 12);
		await writeFile(path, envelope);
		assert.equal(await validateParquetEnvelope(path, envelope.length), 4);
		for (const [length, message] of [
			[0, /malformed/],
			[5, /malformed/],
			[MAX_PARQUET_FOOTER_BYTES + 1, /16 MiB/],
		] as const) {
			envelope.writeUInt32LE(length, 8);
			await writeFile(path, envelope);
			await assert.rejects(validateParquetEnvelope(path, 16), message);
		}
		envelope.writeUInt32LE(4, 8);
		envelope.write("PARE");
		await writeFile(path, envelope);
		await assert.rejects(validateParquetEnvelope(path, 16), /Encrypted/);
		await assert.rejects(validateParquetEnvelope(path, 11), /malformed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("source integrity rechecks exact bytes and hashes without disclosing paths or values", async () => {
	const root = await mkdtemp(join(tmpdir(), "datapi-integrity-"));
	const sourcePath = join(root, "source.csv");
	const source = "x\n001\n";
	const request = {
		kind: "ingest" as const,
		format: "csv" as const,
		sourcePath,
		artifactPath: join(root, "data.duckdb"),
		tempPath: join(root, "temp"),
		expectedByteSize: Buffer.byteLength(source),
		expectedSha256: createHash("sha256").update(source).digest("hex"),
	};
	try {
		await writeFile(sourcePath, source);
		await verifySource(request);
		await writeFile(sourcePath, "x\n999\n");
		await assert.rejects(verifySource(request), /recorded size and SHA-256 hash/);
		await writeFile(sourcePath, "private longer data");
		await assert.rejects(verifySource(request), /recorded size and SHA-256 hash/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unsupported Parquet timestamp precision fails rather than silently rounding", () => {
	assert.throws(() => validateParquetPrecision("INT96", null), /precision/);
	assert.throws(
		() => validateParquetPrecision("INT64", "TimestampType(isAdjustedToUTC=1, unit=TimeUnit(NANOS=NanoSeconds()))"),
		/precision/,
	);
	assert.throws(
		() => validateParquetPrecision("INT64", "TimeType(isAdjustedToUTC=0, unit=TimeUnit(NANOS=NanoSeconds()))"),
		/precision/,
	);
	validateParquetPrecision("INT64", "TimestampType(isAdjustedToUTC=0, unit=TimeUnit(NANOS=NanoSeconds()))");
	validateParquetPrecision("INT64", "TimestampType(isAdjustedToUTC=1, unit=TimeUnit(MICROS=MicroSeconds()))");
});
