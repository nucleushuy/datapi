import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DuckDBAppender, DuckDBConnection, DuckDBResult, DuckDBValue } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";
import { CsvError, parse } from "csv-parse";
import type { AnalyticalMessage, AnalyticalRequest, AnalyticalResult } from "./analytical-contracts.ts";
import {
	CHART_RESULT_BYTES,
	CHART_SAMPLE_BYTES,
	CHART_SAMPLE_CELLS,
	CHART_SAMPLE_ROWS,
	type ChartSample,
} from "./chart-contracts.ts";
import { computeChart } from "./chart-engine.ts";
import { chartColumns } from "./chart-validation.ts";
import type { ColumnProfile, DatasetColumn } from "./contracts.ts";
import {
	MAX_COLUMNS,
	MAX_DECODED_BYTES,
	MAX_PARQUET_ROW_GROUP_BYTES,
	MAX_PREVIEW_BYTES,
	MAX_RECORD_BYTES,
	MAX_TEMP_BYTES,
} from "./contracts.ts";
import { computeDatasetProfile } from "./dataset-profiler.ts";
import {
	DecodedBudget,
	FormatValidationError,
	fail,
	parseAnalyticalRequest,
	sqlIdentifier,
	sqlString,
	validateParquetEnvelope,
	validateParquetPrecision,
	verifySource,
} from "./format-validation.ts";
import {
	PROFILE_REPORT_BYTES,
	PROFILE_REQUEST_BYTES,
	PROFILE_SAMPLE_BYTES,
	PROFILE_SAMPLE_CELLS,
	PROFILE_SAMPLE_ROWS,
} from "./profile-contracts.ts";
import { ColumnProfiler, finiteNumber } from "./profiler.ts";
import { TRANSFORM_PREVIEW_ROWS, TRANSFORM_RESULT_BYTES, type TransformImpact } from "./transform-contracts.ts";
import { createTransformPlan } from "./transform-engine.ts";

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_SCHEMA_NODES = 16_384;
const MAX_SCHEMA_DEPTH = 64;
const FLUSH_BYTES = 1024 * 1024;
const GENERIC_ERROR = "Dataset processing failed; check the file and available disk space.";
type IngestRequest = Extract<AnalyticalRequest, { kind: "ingest" }>;
type PreviewRequest = Extract<AnalyticalRequest, { kind: "preview" }>;
type IngestResult = Extract<AnalyticalResult, { kind: "ingest" }>;

async function send(message: AnalyticalMessage): Promise<void> {
	const line = `${JSON.stringify(message)}\n`;
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
	});
}

function progressReporter(): (bytesProcessed: number, rowCount: number) => Promise<void> {
	let last = 0;
	return async (bytesProcessed, rowCount) => {
		if (Date.now() - last < 1000) return;
		last = Date.now();
		await send({ type: "progress", bytesProcessed, rowCount });
	};
}

async function* rows(result: DuckDBResult): AsyncGenerator<DuckDBValue[]> {
	for (;;) {
		const chunk = await result.fetchChunk();
		if (!chunk || chunk.rowCount === 0) break;
		for (let index = 0; index < chunk.rowCount; index++) yield chunk.getRowValues(index);
	}
}

function text(value: DuckDBValue | undefined): string {
	if (typeof value !== "string") fail("Parquet is malformed; check its signature, footer and data pages.");
	return value;
}

function count(value: DuckDBValue | undefined): number {
	if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
	fail("Parquet is malformed; check its signature, footer and data pages.");
}

function textRow(row: DuckDBValue[]): (string | null)[] {
	return row.map((value) => {
		if (value === null || typeof value === "string") return value;
		return fail(GENERIC_ERROR);
	});
}

async function checkArtifactSize(path: string): Promise<void> {
	let bytes = 0;
	for (const file of [path, `${path}.wal`]) {
		try {
			bytes += (await stat(file)).size;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	if (bytes > MAX_TEMP_BYTES) fail("Derived analytical data exceeds the 512 MiB storage limit.");
}

async function database(
	path: string,
	request: AnalyticalRequest,
	readOnly: boolean,
): Promise<{
	instance: DuckDBInstance;
	connection: DuckDBConnection;
	reader: DuckDBConnection;
}> {
	await mkdir(request.tempPath, { recursive: true });
	const instance = await DuckDBInstance.create(path, {
		access_mode: readOnly ? "READ_ONLY" : "READ_WRITE",
		threads: "1",
		memory_limit: "256MiB",
		max_temp_directory_size: "512MiB",
		temp_directory: request.tempPath,
		autoinstall_known_extensions: "false",
		autoload_known_extensions: "false",
		allow_community_extensions: "false",
		allow_unsigned_extensions: "false",
		allow_persistent_secrets: "false",
		enable_external_file_cache: "false",
		preserve_insertion_order: "true",
	});
	let connection: DuckDBConnection | undefined;
	let reader: DuckDBConnection | undefined;
	try {
		connection = await instance.connect();
		reader = await instance.connect();
		await connection.run("SET TimeZone = 'UTC'");
		await reader.run("SET TimeZone = 'UTC'");
		const allowed = request.kind === "ingest" ? [request.sourcePath, path] : [path];
		await connection.run(`SET allowed_paths = [${allowed.map(sqlString).join(", ")}]`);
		await connection.run("SET enable_external_access = false");
		await connection.run("SET lock_configuration = true");
		return { instance, connection, reader };
	} catch (error) {
		reader?.closeSync();
		connection?.closeSync();
		instance.closeSync();
		throw error;
	}
}

async function createData(connection: DuckDBConnection, width: number): Promise<DuckDBAppender> {
	await connection.run(
		`CREATE TABLE data (row_index BIGINT NOT NULL, ${Array.from({ length: width }, (_, i) => `c${i} VARCHAR`).join(", ")})`,
	);
	return connection.createAppender("data");
}

function append(appender: DuckDBAppender, row: readonly (string | null)[], index: number): void {
	appender.appendBigInt(BigInt(index));
	for (const value of row) {
		if (value === null) appender.appendNull();
		else appender.appendVarchar(value);
	}
	appender.endRow();
}

function schemaBudget(schema: DatasetColumn[], columns?: ColumnProfile[]): void {
	if (Buffer.byteLength(JSON.stringify({ schema, columns })) > MAX_SCHEMA_BYTES) {
		fail("Dataset schema exceeds the supported size or nesting limit.");
	}
}

async function ingestCsv(
	request: IngestRequest,
	connection: DuckDBConnection,
	path: string,
): Promise<Pick<IngestResult, "columns" | "schema" | "rowCount">> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const budget = new DecodedBudget();
	const progress = progressReporter();
	let profiler: ColumnProfiler | undefined;
	let appender: DuckDBAppender | undefined;
	let pendingBytes = 0;
	let fieldBytes = 0;
	const parser = parse({
		bom: true,
		encoding: "utf8",
		delimiter: ",",
		quote: '"',
		escape: '"',
		max_record_size: MAX_RECORD_BYTES,
		skip_empty_lines: false,
		relax_column_count: false,
		trim: false,
		cast(value, context) {
			if (typeof context.column !== "number" || context.column >= MAX_COLUMNS)
				fail("Dataset cannot contain more than 512 columns.");
			fieldBytes += Buffer.byteLength(value);
			if (fieldBytes > MAX_RECORD_BYTES) fail("Dataset record exceeds the 1 MiB serialized size limit.");
			return value;
		},
		on_record(record) {
			fieldBytes = 0;
			return record;
		},
	});
	try {
		await pipeline(
			createReadStream(request.sourcePath, { highWaterMark: 16 * 1024 }),
			async function* (source: AsyncIterable<Buffer>) {
				for await (const chunk of source) {
					try {
						decoder.decode(chunk, { stream: true });
					} catch {
						fail("CSV must contain valid UTF-8 text.");
					}
					yield chunk;
				}
				try {
					decoder.decode();
				} catch {
					fail("CSV must contain valid UTF-8 text.");
				}
			},
			parser,
			async (records: AsyncIterable<string[]>) => {
				for await (const row of records) {
					if (!profiler) {
						if (row.length === 0 || row.some((name) => name.trim().length === 0))
							fail("CSV requires a nonempty header for every column.");
						if (new Set(row).size !== row.length) fail("CSV column headers must be unique.");
						budget.add(row);
						profiler = new ColumnProfiler(row);
						appender = await createData(connection, row.length);
						continue;
					}
					const bytes = budget.add(row);
					if (!appender) fail(GENERIC_ERROR);
					append(appender, row, profiler.rowCount);
					profiler.add(row);
					pendingBytes += bytes;
					if (pendingBytes >= FLUSH_BYTES) {
						appender.flushSync();
						pendingBytes = 0;
						await checkArtifactSize(path);
					}
					await progress(parser.info.bytes, profiler.rowCount);
				}
			},
		);
		if (!profiler) fail("CSV is empty; a header row is required.");
		const columns = profiler.profiles();
		const schema = columns.map(
			(column): DatasetColumn => ({
				index: column.index,
				name: column.name,
				sourceType: "VARCHAR",
				basicType: column.inferredType,
			}),
		);
		schemaBudget(schema, columns);
		return { rowCount: profiler.rowCount, columns, schema };
	} finally {
		appender?.closeSync();
	}
}

function basicType(type: string): DatasetColumn["basicType"] {
	if (/^(?:STRUCT|MAP|UNION|VARIANT)\b/u.test(type) || /\[\d*\]$/u.test(type)) return "nested";
	if (/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL|BIGNUM)\b/u.test(type)) return "number";
	if (type === "BOOLEAN") return "boolean";
	if (/^(?:DATE|TIME|TIMESTAMP|INTERVAL)/u.test(type)) return "datetime";
	if (type === "BLOB" || type === "BIT") return "binary";
	return "text";
}

async function parquetSchema(
	connection: DuckDBConnection,
	source: string,
): Promise<{ schema: DatasetColumn[]; leaves: number }> {
	const result = await connection.stream(
		"SELECT name, type, num_children, logical_type, duckdb_type, column_id FROM parquet_schema($1) ORDER BY column_id",
		[source],
	);
	const names: string[] = [];
	const remaining: number[] = [];
	let nodes = 0;
	let bytes = 0;
	let leaves = 0;
	for await (const row of rows(result)) {
		if (++nodes > MAX_SCHEMA_NODES) fail("Dataset schema exceeds the supported size or nesting limit.");
		bytes += Buffer.byteLength(
			JSON.stringify(row.map((value) => (typeof value === "bigint" ? value.toString() : value))),
		);
		if (bytes > MAX_SCHEMA_BYTES) fail("Dataset schema exceeds the supported size or nesting limit.");
		const children = row[2] === null ? 0 : count(row[2]);
		const physical = row[1] === null ? null : text(row[1]);
		const logical = row[3] === null ? null : text(row[3]);
		validateParquetPrecision(physical, logical);
		if (count(row[5]) !== nodes - 1) fail("Parquet is malformed; check its signature, footer and data pages.");
		if (nodes === 1) {
			if (children < 1) fail("Parquet is malformed; check its signature, footer and data pages.");
			if (children > MAX_COLUMNS) fail("Dataset cannot contain more than 512 columns.");
			remaining.push(children);
			continue;
		}
		while (remaining.at(-1) === 0) remaining.pop();
		if (remaining.length === 0) fail("Parquet is malformed; check its signature, footer and data pages.");
		if (remaining.length === 1) {
			names.push(text(row[0]));
		}
		remaining[remaining.length - 1]--;
		if (children > 0) remaining.push(children);
		else leaves++;
		if (remaining.length > MAX_SCHEMA_DEPTH) fail("Dataset schema exceeds the supported size or nesting limit.");
	}
	if (nodes === 0 || remaining.some((value) => value !== 0) || leaves === 0 || names.length === 0)
		fail("Parquet is malformed; check its signature, footer and data pages.");
	// parquet_schema has null duckdb_type for group nodes. Bind the checked file
	// without reading rows to obtain complete LIST/STRUCT/MAP types.
	const shape = await connection.run(
		"SELECT * FROM read_parquet($1, hive_partitioning=false, union_by_name=false) LIMIT 0",
		[source],
	);
	if (shape.columnCount !== names.length) fail("Parquet is malformed; check its signature, footer and data pages.");
	const schema = names.map((name, index): DatasetColumn => {
		const sourceType = String(shape.columnType(index));
		return { index, name, sourceType, basicType: basicType(sourceType) };
	});
	schemaBudget(schema);
	return { schema, leaves };
}

async function parquetMetadata(
	connection: DuckDBConnection,
	request: IngestRequest,
	dataEnd: number,
	leaves: number,
): Promise<number> {
	let expectedRows = -1;
	let expectedGroups = -1;
	const files = await connection.stream(
		"SELECT num_rows, num_row_groups, encryption_algorithm FROM parquet_file_metadata($1)",
		[request.sourcePath],
	);
	for await (const row of rows(files)) {
		if (expectedRows !== -1) fail("Parquet is malformed; check its signature, footer and data pages.");
		expectedRows = count(row[0]);
		expectedGroups = count(row[1]);
		if (row[2] !== null && row[2] !== "") fail("Encrypted Parquet is not supported.");
	}
	let group = -1;
	let groupRows = 0;
	let groupColumns = 0;
	let groupBytes = 0;
	let totalBytes = 0;
	let totalRows = 0;
	const metadata = await connection.stream(
		"SELECT row_group_id, row_group_num_rows, row_group_num_columns, row_group_bytes, column_id, total_uncompressed_size, total_compressed_size, data_page_offset, dictionary_page_offset FROM parquet_metadata($1) ORDER BY row_group_id, column_id",
		[request.sourcePath],
	);
	for await (const row of rows(metadata)) {
		const id = count(row[0]);
		const rowCount = count(row[1]);
		if (id !== group) {
			if (id !== group + 1 || (group >= 0 && groupColumns !== leaves))
				fail("Parquet is malformed; check its signature, footer and data pages.");
			group = id;
			groupRows = rowCount;
			groupColumns = 0;
			groupBytes = 0;
			totalRows += rowCount;
		}
		if (rowCount !== groupRows || count(row[2]) !== leaves || count(row[4]) !== groupColumns)
			fail("Parquet is malformed; check its signature, footer and data pages.");
		groupColumns++;
		const uncompressed = count(row[5]);
		groupBytes += uncompressed;
		totalBytes += uncompressed;
		if (
			groupBytes > MAX_PARQUET_ROW_GROUP_BYTES ||
			count(row[3]) > MAX_PARQUET_ROW_GROUP_BYTES ||
			totalBytes > MAX_DECODED_BYTES
		)
			fail("Parquet metadata exceeds the declared decoded-size limits.");
		const compressed = count(row[6]);
		const offset = count(row[7]);
		const dictionary = row[8] === null ? 0 : count(row[8]);
		const start = dictionary > 0 ? Math.min(dictionary, offset) : offset;
		if (start < 4 || offset >= dataEnd || start + compressed > dataEnd)
			fail("Parquet is malformed; check its signature, footer and data pages.");
	}
	if (
		expectedRows < 0 ||
		expectedGroups !== group + 1 ||
		totalRows !== expectedRows ||
		(group >= 0 && groupColumns !== leaves)
	)
		fail("Parquet is malformed; check its signature, footer and data pages.");
	return expectedRows;
}

function parquetProfiles(schema: DatasetColumn[]): ColumnProfile[] {
	return schema.map((column) => ({
		index: column.index,
		name: column.name,
		inferredType: "empty",
		emptyCount: 0,
		numericCount: 0,
		min: null,
		max: null,
	}));
}

function addParquetProfile(
	columns: ColumnProfile[],
	schema: DatasetColumn[],
	row: (string | null)[],
	unavailableExtrema: Set<number>,
): void {
	for (let index = 0; index < row.length; index++) {
		const value = row[index];
		const column = columns[index];
		if (value === null) {
			column.emptyCount++;
			continue;
		}
		const type = schema[index];
		column.inferredType = type.basicType === "number" || type.basicType === "boolean" ? type.basicType : "text";
		if (type.basicType !== "number") continue;
		const numeric = finiteNumber(value);
		if (numeric === null) continue;
		column.numericCount++;
		// Exact source text remains authoritative. Never publish rounded decimal/large-integer extrema.
		if (
			!/^(?:FLOAT|DOUBLE)$/u.test(type.sourceType) &&
			(!/INT|BIGNUM/u.test(type.sourceType) || !Number.isSafeInteger(numeric))
		) {
			unavailableExtrema.add(index);
			column.min = null;
			column.max = null;
		}
		if (unavailableExtrema.has(index)) continue;
		column.min = column.min === null ? numeric : Math.min(column.min, numeric);
		column.max = column.max === null ? numeric : Math.max(column.max, numeric);
	}
}

async function ingestParquet(
	request: IngestRequest,
	connection: DuckDBConnection,
	reader: DuckDBConnection,
	path: string,
	dataEnd: number,
): Promise<Pick<IngestResult, "columns" | "schema" | "rowCount">> {
	const { schema, leaves } = await parquetSchema(reader, request.sourcePath);
	const expectedRows = await parquetMetadata(reader, request, dataEnd, leaves);
	const columns = parquetProfiles(schema);
	const unavailableExtrema = new Set<number>();
	const names = schema.map((_, index) => `c${index}`);
	const query = `SELECT ${names.map((name) => `CAST(src.${sqlIdentifier(name)} AS VARCHAR)`).join(", ")} FROM read_parquet($1, hive_partitioning=false, union_by_name=false) AS src(${names.join(", ")})`;
	const source = await reader.stream(query, [request.sourcePath]);
	if (source.columnCount !== schema.length) fail("Parquet is malformed; check its signature, footer and data pages.");
	const appender = await createData(connection, schema.length);
	const budget = new DecodedBudget();
	const progress = progressReporter();
	let rowCount = 0;
	let pendingBytes = 0;
	try {
		for await (const values of rows(source)) {
			const row = textRow(values);
			pendingBytes += budget.add(row);
			append(appender, row, rowCount++);
			addParquetProfile(columns, schema, row, unavailableExtrema);
			if (pendingBytes >= FLUSH_BYTES) {
				appender.flushSync();
				pendingBytes = 0;
				await checkArtifactSize(path);
			}
			await progress(request.expectedByteSize, rowCount);
		}
	} finally {
		appender.closeSync();
	}
	if (rowCount !== expectedRows) fail("Parquet is malformed; check its signature, footer and data pages.");
	schemaBudget(schema, columns);
	return { rowCount, columns, schema };
}

async function ingest(request: IngestRequest): Promise<IngestResult> {
	await verifySource(request);
	const dataEnd =
		request.format === "parquet" ? await validateParquetEnvelope(request.sourcePath, request.expectedByteSize) : 0;
	try {
		await lstat(request.artifactPath);
		fail("Analytical worker request is invalid.");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const path = `${request.artifactPath}.partial`;
	let published = false;
	try {
		// Reserve the name without allowing an existing artifact to be opened or overwritten.
		const reservation = await open(path, "wx", 0o600);
		await reservation.close();
		await rm(path);
		const { instance, connection, reader } = await database(path, request, false);
		let result: IngestResult;
		try {
			await connection.run("BEGIN TRANSACTION");
			const facts =
				request.format === "csv"
					? await ingestCsv(request, connection, path)
					: await ingestParquet(request, connection, reader, path, dataEnd);
			await verifySource(request);
			await connection.run("COMMIT");
			await connection.run("CHECKPOINT");
			const version = await connection.run("SELECT version()");
			const chunk = await version.fetchChunk();
			if (!chunk || chunk.rowCount !== 1) fail(GENERIC_ERROR);
			result = {
				kind: "ingest",
				byteSize: request.expectedByteSize,
				sha256: request.expectedSha256,
				...facts,
				engineVersion: text(chunk.getRowValues(0)[0]).replace(/^v/u, ""),
			};
		} finally {
			reader.closeSync();
			connection.closeSync();
			instance.closeSync();
		}
		await checkArtifactSize(path);
		await rename(path, request.artifactPath);
		published = true;
		return result;
	} finally {
		if (!published) {
			await rm(path, { force: true });
			await rm(`${path}.wal`, { force: true });
		}
	}
}

async function preview(request: PreviewRequest): Promise<AnalyticalResult> {
	const info = await lstat(request.artifactPath);
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TEMP_BYTES)
		fail("Analytical preview is invalid or its artifact is unavailable.");
	const { instance, connection, reader } = await database(request.artifactPath, request, true);
	try {
		const shape = await connection.run("SELECT * FROM data LIMIT 0");
		const width = shape.columnCount - 1;
		if (width < 1 || width > MAX_COLUMNS || shape.columnName(0) !== "row_index")
			fail("Analytical preview is invalid or its artifact is unavailable.");
		const names = Array.from({ length: width }, (_, index) => `c${index}`);
		if (names.some((name, index) => shape.columnName(index + 1) !== name))
			fail("Analytical preview is invalid or its artifact is unavailable.");
		const result = await connection.stream(
			`SELECT ${names.join(", ")} FROM data WHERE row_index >= $1 ORDER BY row_index LIMIT $2`,
			[BigInt(request.offset), request.limit],
		);
		const output: (string | null)[][] = [];
		let bytes = Buffer.byteLength(
			JSON.stringify({ offset: request.offset, limit: request.limit, total: request.total, rows: [] }),
		);
		for await (const values of rows(result)) {
			const row = textRow(values);
			const rowBytes = Buffer.byteLength(JSON.stringify(row));
			if (rowBytes + 1 > MAX_RECORD_BYTES) fail("Analytical preview is invalid or its artifact is unavailable.");
			if (bytes + rowBytes + (output.length > 0 ? 1 : 0) > MAX_PREVIEW_BYTES) break;
			bytes += rowBytes + (output.length > 0 ? 1 : 0);
			output.push(row);
		}
		return {
			kind: "preview",
			preview: { offset: request.offset, limit: request.limit, total: request.total, rows: output },
		};
	} finally {
		reader.closeSync();
		connection.closeSync();
		instance.closeSync();
	}
}

async function chartDataset(request: Extract<AnalyticalRequest, { kind: "chart" }>): Promise<AnalyticalResult> {
	const { input } = request;
	const info = await lstat(request.artifactPath);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== input.storageBytes || info.size > MAX_TEMP_BYTES)
		fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
	const hash = createHash("sha256");
	let hashedBytes = 0;
	for await (const chunk of createReadStream(request.artifactPath, { highWaterMark: 64 * 1024 })) {
		hashedBytes += chunk.length;
		if (hashedBytes > MAX_TEMP_BYTES) fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
		hash.update(chunk);
	}
	if (hashedBytes !== input.storageBytes || hash.digest("hex") !== input.datasetVersionHash)
		fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
	const { instance, connection, reader } = await database(request.artifactPath, request, true);
	try {
		const shape = await connection.run("SELECT * FROM data LIMIT 0");
		if (
			shape.columnCount !== input.schema.length + 1 ||
			shape.columnName(0) !== "row_index" ||
			input.schema.some((_, index) => shape.columnName(index + 1) !== `c${index}`)
		)
			fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
		const population = await connection.run("SELECT count(*) FROM data");
		const chunk = await population.fetchChunk();
		if (!chunk || count(chunk.getRowValues(0)[0]) !== input.rowCount)
			fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
		const columns = chartColumns(request.spec, input.schema);
		const capacity = Math.min(CHART_SAMPLE_ROWS, Math.floor(CHART_SAMPLE_CELLS / columns.length));
		const stride = Math.max(1, Math.ceil(input.rowCount / capacity));
		// Limit identifiers before projecting wide values; avoids DuckDB wide Top-N allocation.
		const result = await connection.stream(
			`SELECT row_index, ${columns.map((column) => `c${column.index}`).join(", ")} FROM data WHERE row_index IN (SELECT row_index FROM data WHERE row_index % $1 = 0 ORDER BY row_index LIMIT $2) ORDER BY row_index`,
			[BigInt(stride), capacity],
		);
		const sample: ChartSample = { columns, rows: [], populationRows: input.rowCount, stride, byteLimited: false };
		let bytes = 0;
		const progress = progressReporter();
		await send({ type: "progress", bytesProcessed: 0, rowCount: 0 });
		for await (const values of rows(result)) {
			const row = { rowId: count(values[0]), values: textRow(values.slice(1)) };
			const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (rowBytes > MAX_RECORD_BYTES + 128) fail("Dataset record exceeds the 1 MiB serialized size limit.");
			if (bytes + rowBytes > CHART_SAMPLE_BYTES) {
				sample.byteLimited = true;
				break;
			}
			bytes += rowBytes;
			sample.rows.push(row);
			await progress(0, sample.rows.length);
		}
		const chart = computeChart(request.spec, sample, input.datasetVersionHash, new Date().toISOString());
		if (Buffer.byteLength(JSON.stringify(chart)) > CHART_RESULT_BYTES)
			fail("Chart result exceeds the supported display size; reduce fields or categories.");
		return { kind: "chart", chart };
	} finally {
		reader.closeSync();
		connection.closeSync();
		instance.closeSync();
	}
}

async function profileDataset(request: Extract<AnalyticalRequest, { kind: "profile" }>): Promise<AnalyticalResult> {
	const input = request.input;
	const info = await lstat(request.artifactPath);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== input.storageBytes || info.size > MAX_TEMP_BYTES)
		fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
	const hash = createHash("sha256");
	let hashedBytes = 0;
	for await (const chunk of createReadStream(request.artifactPath, { highWaterMark: 64 * 1024 })) {
		hashedBytes += chunk.length;
		if (hashedBytes > MAX_TEMP_BYTES) fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
		hash.update(chunk);
	}
	if (hashedBytes !== input.storageBytes || hash.digest("hex") !== input.datasetVersionHash)
		fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
	const { instance, connection, reader } = await database(request.artifactPath, request, true);
	try {
		const shape = await connection.run("SELECT * FROM data LIMIT 0");
		const names = input.schema.map((_, index) => `c${index}`);
		if (
			shape.columnCount !== names.length + 1 ||
			shape.columnName(0) !== "row_index" ||
			names.some((name, index) => shape.columnName(index + 1) !== name)
		)
			fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
		const population = await connection.run("SELECT count(*) FROM data");
		const chunk = await population.fetchChunk();
		if (!chunk || count(chunk.getRowValues(0)[0]) !== input.rowCount)
			fail("Profile artifact does not match its recorded SHA-256 hash or schema.");
		const capacity = Math.min(PROFILE_SAMPLE_ROWS, Math.floor(PROFILE_SAMPLE_CELLS / names.length));
		const stride = Math.max(1, Math.ceil(input.rowCount / capacity));
		const result = await connection.stream(
			`SELECT ${names.join(", ")} FROM data WHERE row_index IN (SELECT row_index FROM data WHERE row_index % $1 = 0 ORDER BY row_index LIMIT $2) ORDER BY row_index`,
			[BigInt(stride), capacity],
		);
		const sample: (string | null)[][] = [];
		let bytes = 0;
		let byteLimited = false;
		const progress = progressReporter();
		await send({ type: "progress", bytesProcessed: 0, rowCount: 0 });
		for await (const values of rows(result)) {
			const row = textRow(values);
			const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (rowBytes > MAX_RECORD_BYTES) fail("Dataset record exceeds the 1 MiB serialized size limit.");
			if (bytes + rowBytes > PROFILE_SAMPLE_BYTES) {
				byteLimited = true;
				break;
			}
			bytes += rowBytes;
			sample.push(row);
			await progress(0, sample.length);
		}
		const approximate = sample.length < input.rowCount;
		const profile = computeDatasetProfile(
			input,
			sample,
			{
				method: approximate ? "systematic" : "full",
				populationRows: input.rowCount,
				sampleSize: sample.length,
				stride,
				byteLimited,
				approximate,
			},
			new Date().toISOString(),
		);
		if (Buffer.byteLength(JSON.stringify(profile)) > PROFILE_REPORT_BYTES)
			fail("Profile exceeds the supported report size.");
		await send({ type: "progress", bytesProcessed: 0, rowCount: sample.length });
		return { kind: "profile", profile };
	} finally {
		reader.closeSync();
		connection.closeSync();
		instance.closeSync();
	}
}

async function verifyTransformInput(request: Extract<AnalyticalRequest, { kind: "transform" }>): Promise<void> {
	const info = await lstat(request.artifactPath);
	const invalid = "Transformation input does not match its recorded SHA-256 hash, schema or population.";
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.size !== request.input.storageBytes ||
		info.size > MAX_TEMP_BYTES
	)
		fail(invalid);
	try {
		await lstat(`${request.artifactPath}.wal`);
		fail(invalid);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(request.artifactPath, { highWaterMark: 64 * 1024 })) {
		bytes += chunk.length;
		if (bytes > request.input.storageBytes) fail(invalid);
		hash.update(chunk);
	}
	if (bytes !== request.input.storageBytes || hash.digest("hex") !== request.input.datasetVersionHash) fail(invalid);
}

async function transformDataset(request: Extract<AnalyticalRequest, { kind: "transform" }>): Promise<AnalyticalResult> {
	await verifyTransformInput(request);
	try {
		await lstat(request.outputPath);
		fail("Transformation output already exists or aliases the input.");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	await mkdir(request.tempPath, { recursive: true });
	const stage = await mkdtemp(join(request.tempPath, "transform-"));
	const output = join(stage, "output.duckdb");
	let published = false;
	try {
		const source = await database(request.artifactPath, { ...request, tempPath: join(stage, "source-spill") }, true);
		let impact: TransformImpact;
		try {
			const invalid = "Transformation input does not match its recorded SHA-256 hash, schema or population.";
			const shape = await source.connection.run("SELECT * FROM data LIMIT 0");
			if (
				shape.columnCount !== request.input.schema.length + 1 ||
				shape.columnName(0) !== "row_index" ||
				String(shape.columnType(0)) !== "BIGINT" ||
				request.input.schema.some(
					(entry, index) =>
						entry.index !== index ||
						shape.columnName(index + 1) !== `c${index}` ||
						String(shape.columnType(index + 1)) !== "VARCHAR",
				)
			)
				fail(invalid);
			const population = await source.connection.run(
				"SELECT count(*), count(DISTINCT row_index), min(row_index), max(row_index) FROM data",
			);
			const populationChunk = await population.fetchChunk();
			if (!populationChunk || populationChunk.rowCount !== 1) fail(invalid);
			const populationRow = populationChunk.getRowValues(0);
			if (
				count(populationRow[0]) !== request.input.rowCount ||
				count(populationRow[1]) !== request.input.rowCount ||
				(request.input.rowCount > 0 &&
					(populationRow[2] !== 0n || populationRow[3] !== BigInt(request.input.rowCount - 1)))
			)
				fail(invalid);
			const before: (string | null)[][] = [];
			const inputNulls = request.input.schema.map(() => 0);
			const inputBudget = new DecodedBudget();
			let beforeBytes = 2;
			let beforeLimited = false;
			const inputRows = await source.reader.stream(
				`SELECT ${request.input.schema.map((_, index) => `c${index}`).join(", ")} FROM data ORDER BY row_index`,
			);
			for await (const values of rows(inputRows)) {
				const row = textRow(values);
				const bytes = inputBudget.add(row);
				row.forEach((value, index) => {
					if (value === null) inputNulls[index]++;
				});
				if (before.length < TRANSFORM_PREVIEW_ROWS && !beforeLimited) {
					if (beforeBytes + bytes > TRANSFORM_RESULT_BYTES / 4) beforeLimited = true;
					else {
						before.push(row);
						beforeBytes += bytes;
					}
				}
			}
			const plan = await createTransformPlan(source.connection, request.spec, request.input.schema);
			const target = await database(output, { ...request, tempPath: join(stage, "target-spill") }, false);
			let rowCount = 0;
			let affectedRows = 0;
			const after: (string | null)[][] = [];
			let afterBytes = 2;
			let afterLimited = false;
			const columns = parquetProfiles(plan.schema);
			const unavailableExtrema = new Set<number>();
			try {
				await target.connection.run("BEGIN TRANSACTION");
				const appender = await createData(target.connection, plan.schema.length);
				const budget = new DecodedBudget();
				let pending = 0;
				const progress = progressReporter();
				await send({ type: "progress", bytesProcessed: 0, rowCount: 0 });
				try {
					const result = await source.connection.stream(plan.sql);
					for await (const values of rows(result)) {
						if (
							values.length !== plan.schema.length + 2 ||
							values[0] !== BigInt(rowCount) ||
							typeof values.at(-1) !== "boolean"
						)
							fail(invalid);
						const row = textRow(values.slice(1, -1));
						const bytes = budget.add(row);
						pending += bytes;
						append(appender, row, rowCount++);
						if (values.at(-1) === true) affectedRows++;
						addParquetProfile(columns, plan.schema, row, unavailableExtrema);
						if (after.length < TRANSFORM_PREVIEW_ROWS && !afterLimited) {
							if (afterBytes + bytes > TRANSFORM_RESULT_BYTES / 4) afterLimited = true;
							else {
								after.push(row);
								afterBytes += bytes;
							}
						}
						if (pending >= FLUSH_BYTES) {
							appender.flushSync();
							pending = 0;
							await checkArtifactSize(output);
						}
						await progress(0, rowCount);
					}
				} finally {
					appender.closeSync();
				}
				await verifyTransformInput(request);
				await target.connection.run("COMMIT");
				await target.connection.run("CHECKPOINT");
			} finally {
				target.reader.closeSync();
				target.connection.closeSync();
				target.instance.closeSync();
			}
			const versionResult = await source.connection.run("SELECT version()");
			const versionChunk = await versionResult.fetchChunk();
			if (!versionChunk || versionChunk.rowCount !== 1) fail(GENERIC_ERROR);
			const beforeByName = new Map(request.input.schema.map((entry, index) => [entry.name, inputNulls[index]]));
			const afterByName = new Map(plan.schema.map((entry, index) => [entry.name, columns[index].emptyCount]));
			impact = {
				inputVersionId: request.input.datasetVersionId,
				inputHash: request.input.datasetVersionHash,
				spec: request.spec,
				engineVersion: text(versionChunk.getRowValues(0)[0]).replace(/^v/u, ""),
				sql: plan.sql,
				rowCount,
				inputRows: request.input.rowCount,
				affectedRows: plan.removedRows ? request.input.rowCount - rowCount : affectedRows,
				schema: plan.schema,
				schemaBefore: request.input.schema,
				columns,
				before,
				after,
				nullChanges: [...new Set([...beforeByName.keys(), ...afterByName.keys()])].map((name) => ({
					name,
					before: beforeByName.get(name) ?? null,
					after: afterByName.get(name) ?? null,
				})),
				warnings: plan.warnings,
			};
			if (beforeLimited || afterLimited)
				impact.warnings.push(
					"Preview samples were byte-limited; complete input/output counts and null deltas remain exact.",
				);
			if (unavailableExtrema.size)
				impact.warnings.push(
					"Basic numeric extrema are omitted where binary floating-point would lose exact decimal or large-integer precision.",
				);
			if (Buffer.byteLength(JSON.stringify(impact)) > TRANSFORM_RESULT_BYTES)
				fail("Transformation result exceeds the supported report size.");
		} finally {
			source.reader.closeSync();
			source.connection.closeSync();
			source.instance.closeSync();
		}
		await verifyTransformInput(request);
		await checkArtifactSize(output);
		// COPYFILE_EXCL is a no-replace publish even if another process created the destination meanwhile.
		await copyFile(output, request.outputPath, constants.COPYFILE_EXCL);
		published = true;
		const file = await open(request.outputPath, "r+");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		return { kind: "transform", impact };
	} catch (error) {
		if (published) await rm(request.outputPath, { force: true });
		throw error;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path || (await stat(path)).size > PROFILE_REQUEST_BYTES) fail("Analytical worker request is invalid.");
	const request = parseAnalyticalRequest(JSON.parse(await readFile(path, "utf8")) as unknown);
	const result =
		request.kind === "ingest"
			? await ingest(request)
			: request.kind === "profile"
				? await profileDataset(request)
				: request.kind === "chart"
					? await chartDataset(request)
					: request.kind === "transform"
						? await transformDataset(request)
						: await preview(request);
	await send({ type: "result", result });
}

void main().catch(async (error: unknown) => {
	let message: AnalyticalMessage & { type: "error" } = { type: "error", error: GENERIC_ERROR };
	if (error instanceof FormatValidationError) {
		// Every instance is constructed through the statically curated fail() boundary.
		message = { type: "error", error: error.message as (typeof message)["error"] };
	} else if (error instanceof CsvError) {
		message = {
			type: "error",
			error:
				error.code === "CSV_MAX_RECORD_SIZE"
					? "Dataset record exceeds the 1 MiB serialized size limit."
					: "CSV is malformed; check quoting and consistent column counts.",
		};
	}
	process.exitCode = 1;
	await send(message);
});
