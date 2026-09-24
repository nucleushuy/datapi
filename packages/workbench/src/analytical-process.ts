import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYTICAL_ERROR_MESSAGES, type AnalyticalRequest, type AnalyticalResult } from "./analytical-contracts.ts";
import { parseChartSpec } from "./chart-spec.ts";
import { isChartResult } from "./chart-validation.ts";
import {
	type ColumnProfile,
	type DatasetColumn,
	MAX_COLUMNS,
	MAX_PREVIEW_BYTES,
	MAX_PREVIEW_ROWS,
	MAX_UPLOAD_BYTES,
	PROCESSING_TIMEOUT_MS,
} from "./contracts.ts";
import { parseAnalyticalRequest } from "./format-validation.ts";
import { PROFILE_REQUEST_BYTES } from "./profile-contracts.ts";
import { isDatasetProfile, isProfileInput } from "./profile-validation.ts";
import { TRANSFORM_PREVIEW_ROWS, TRANSFORM_RESULT_BYTES } from "./transform-contracts.ts";
import { parseTransformSpec } from "./transform-spec.ts";

const MAX_MESSAGE_BYTES = MAX_PREVIEW_BYTES + 4 * 1024 * 1024;
const MAX_PROGRESS_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = PROFILE_REQUEST_BYTES;
const PROTOCOL_ERROR = "Analytical worker returned an invalid response.";
const ISOLATION_ERROR = "Analytical processing requires Windows 10 or later with available hard memory limits.";
const CANCELLED_ERROR = "Dataset processing was cancelled.";
const TIMEOUT_ERROR = "Dataset processing exceeded the five-minute limit.";
const PROCESS_ERROR = "Analytical worker stopped unexpectedly or exceeded its memory limit.";
const safeWorkerErrors: ReadonlySet<string> = new Set(ANALYTICAL_ERROR_MESSAGES);

class AnalyticalProcessError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function profile(value: unknown, index: number, rows: number): value is ColumnProfile {
	if (!record(value) || !keys(value, ["index", "name", "inferredType", "emptyCount", "numericCount", "min", "max"]))
		return false;
	return (
		value.index === index &&
		typeof value.name === "string" &&
		typeof value.inferredType === "string" &&
		["empty", "number", "boolean", "text"].includes(value.inferredType) &&
		count(value.emptyCount) &&
		count(value.numericCount) &&
		value.emptyCount + value.numericCount <= rows &&
		((value.min === null && value.max === null) ||
			(value.numericCount > 0 &&
				typeof value.min === "number" &&
				typeof value.max === "number" &&
				Number.isFinite(value.min) &&
				Number.isFinite(value.max) &&
				value.min <= value.max))
	);
}

function column(value: unknown, index: number): value is DatasetColumn {
	return (
		record(value) &&
		keys(value, ["index", "name", "sourceType", "basicType"]) &&
		value.index === index &&
		typeof value.name === "string" &&
		typeof value.sourceType === "string" &&
		value.sourceType.length > 0 &&
		typeof value.basicType === "string" &&
		["empty", "number", "boolean", "text", "datetime", "binary", "nested"].includes(value.basicType)
	);
}

function transformMatches(value: unknown, request: Extract<AnalyticalRequest, { kind: "transform" }>): boolean {
	if (
		!record(value) ||
		!keys(value, [
			"inputVersionId",
			"inputHash",
			"spec",
			"engineVersion",
			"sql",
			"affectedRows",
			"inputRows",
			"nullChanges",
			"schemaBefore",
			"before",
			"after",
			"warnings",
			"rowCount",
			"schema",
			"columns",
		])
	)
		return false;
	if (
		Buffer.byteLength(JSON.stringify(value)) > TRANSFORM_RESULT_BYTES ||
		value.inputVersionId !== request.input.datasetVersionId ||
		value.inputHash !== request.input.datasetVersionHash ||
		value.inputRows !== request.input.rowCount ||
		!count(value.rowCount) ||
		value.rowCount > request.input.rowCount ||
		!count(value.affectedRows) ||
		value.affectedRows > request.input.rowCount ||
		typeof value.engineVersion !== "string" ||
		!/^[a-zA-Z0-9.+_-]{1,80}$/u.test(value.engineVersion) ||
		typeof value.sql !== "string" ||
		!value.sql.startsWith("SELECT row_number() OVER (ORDER BY source_row_index) - 1 AS row_index, ") ||
		!Array.isArray(value.warnings) ||
		value.warnings.length > 20 ||
		!value.warnings.every((entry: unknown) => typeof entry === "string") ||
		JSON.stringify(value.schemaBefore) !== JSON.stringify(request.input.schema)
	)
		return false;
	try {
		if (
			JSON.stringify(parseTransformSpec(value.spec, request.input.schema, request.input.datasetVersionId)) !==
			JSON.stringify(parseTransformSpec(request.spec, request.input.schema, request.input.datasetVersionId))
		)
			return false;
	} catch {
		return false;
	}
	if (
		!Array.isArray(value.schema) ||
		value.schema.length < 1 ||
		value.schema.length > MAX_COLUMNS ||
		!value.schema.every((entry: unknown, index: number) => column(entry, index)) ||
		!Array.isArray(value.columns) ||
		value.columns.length !== value.schema.length
	)
		return false;
	const schema = value.schema as DatasetColumn[];
	const columns: unknown[] = value.columns;
	const rowCount = value.rowCount;
	if (
		new Set(schema.map((entry) => entry.name)).size !== schema.length ||
		!columns.every((entry, index) => profile(entry, index, rowCount) && entry.name === schema[index].name)
	)
		return false;
	const op = request.spec.operation;
	const removes = op.kind === "filter" || op.kind === "deduplicate" || (op.kind === "missing" && op.method === "drop");
	if (removes ? value.affectedRows !== request.input.rowCount - rowCount : rowCount !== request.input.rowCount)
		return false;
	const expected = request.input.schema
		.filter((entry) => op.kind !== "drop" || !op.columns.includes(entry.index))
		.map((entry) => ({ ...entry, name: op.kind === "rename" && op.column === entry.index ? op.name : entry.name }));
	const appended = op.kind === "derive" || op.kind === "datetime" || op.kind === "scale" || op.kind === "encode";
	if (
		(!appended && schema.length !== expected.length) ||
		(appended && schema.length <= expected.length) ||
		expected.some((entry, index) => schema[index]?.name !== entry.name)
	)
		return false;
	if (appended) {
		const additions = schema.slice(expected.length);
		if (op.kind === "encode" && op.method === "one-hot") {
			if (
				additions.length > 128 ||
				(op.categories.length > 0 && additions.length !== op.categories.length) ||
				additions.some((entry, index) => entry.name !== `${op.name}_${index}`)
			)
				return false;
		} else if (additions.length !== 1 || additions[0].name !== op.name) return false;
		if (value.affectedRows !== request.input.rowCount) return false;
	}
	const samples = (sample: unknown, width: number, available: number): boolean =>
		Array.isArray(sample) &&
		sample.length <= Math.min(TRANSFORM_PREVIEW_ROWS, available) &&
		sample.every(
			(row: unknown) =>
				Array.isArray(row) &&
				row.length === width &&
				row.every((cell: unknown) => cell === null || typeof cell === "string"),
		);
	if (
		!samples(value.before, request.input.schema.length, request.input.rowCount) ||
		!samples(value.after, schema.length, rowCount)
	)
		return false;
	const names = [
		...new Set([...request.input.schema.map((entry) => entry.name), ...schema.map((entry) => entry.name)]),
	];
	if (!Array.isArray(value.nullChanges) || value.nullChanges.length !== names.length) return false;
	return value.nullChanges.every((entry: unknown, index: number) => {
		if (!record(entry) || !keys(entry, ["name", "before", "after"]) || entry.name !== names[index]) return false;
		const beforeIndex = request.input.schema.findIndex((candidate) => candidate.name === entry.name);
		const afterIndex = schema.findIndex((candidate) => candidate.name === entry.name);
		const afterProfile = columns[afterIndex];
		return (
			(beforeIndex < 0 ? entry.before === null : count(entry.before) && entry.before <= request.input.rowCount) &&
			(afterIndex < 0 ? entry.after === null : record(afterProfile) && entry.after === afterProfile.emptyCount)
		);
	});
}

function resultMatches(value: unknown, request: AnalyticalRequest): value is AnalyticalResult {
	if (!record(value) || value.kind !== request.kind) return false;
	if (request.kind === "transform") return keys(value, ["kind", "impact"]) && transformMatches(value.impact, request);
	if (request.kind === "chart")
		return keys(value, ["kind", "chart"]) && isChartResult(value.chart, request.input, request.spec);
	if (request.kind === "profile")
		return keys(value, ["kind", "profile"]) && isDatasetProfile(value.profile, request.input);
	if (request.kind === "ingest") {
		if (
			!keys(value, ["kind", "byteSize", "sha256", "rowCount", "columns", "schema", "engineVersion"]) ||
			value.byteSize !== request.expectedByteSize ||
			value.sha256 !== request.expectedSha256 ||
			!count(value.rowCount) ||
			!Array.isArray(value.columns) ||
			!Array.isArray(value.schema) ||
			value.columns.length < 1 ||
			value.columns.length > MAX_COLUMNS ||
			value.schema.length !== value.columns.length ||
			typeof value.engineVersion !== "string" ||
			!/^[a-zA-Z0-9.+_-]{1,80}$/.test(value.engineVersion)
		)
			return false;
		const rows = value.rowCount;
		const columns: unknown[] = value.columns;
		return (
			columns.every((entry, index) => profile(entry, index, rows)) &&
			value.schema.every((entry: unknown, index: number) => {
				const corresponding = columns[index];
				return column(entry, index) && record(corresponding) && entry.name === corresponding.name;
			})
		);
	}
	if (!keys(value, ["kind", "preview"]) || !record(value.preview)) return false;
	const preview = value.preview;
	const available = Math.min(request.limit, Math.max(0, request.total - request.offset));
	if (
		!keys(preview, ["offset", "limit", "total", "rows"]) ||
		preview.offset !== request.offset ||
		preview.limit !== request.limit ||
		preview.total !== request.total ||
		!Array.isArray(preview.rows) ||
		preview.rows.length > available ||
		(available > 0 && preview.rows.length === 0) ||
		Buffer.byteLength(JSON.stringify(preview)) > MAX_PREVIEW_BYTES
	)
		return false;
	let width: number | undefined;
	return preview.rows.every((row: unknown) => {
		if (!Array.isArray(row) || row.length < 1 || row.length > MAX_COLUMNS) return false;
		width ??= row.length;
		return row.length === width && row.every((cell: unknown) => cell === null || typeof cell === "string");
	});
}

function requestValid(request: AnalyticalRequest): boolean {
	if (request.kind === "transform") {
		try {
			parseAnalyticalRequest(request);
			return true;
		} catch {
			return false;
		}
	}
	const paths = [request.artifactPath, request.tempPath];
	if (request.kind === "ingest") paths.push(request.sourcePath);
	if (!paths.every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"))) return false;
	if (request.kind === "chart") {
		if (!isProfileInput(request.input)) return false;
		try {
			parseChartSpec(request.spec, request.input.schema, request.input.datasetVersionId);
			return true;
		} catch {
			return false;
		}
	}
	if (request.kind === "profile") return isProfileInput(request.input);
	return request.kind === "ingest"
		? (request.format === "csv" || request.format === "parquet") &&
				count(request.expectedByteSize) &&
				request.expectedByteSize <= MAX_UPLOAD_BYTES &&
				/^[a-f0-9]{64}$/.test(request.expectedSha256)
		: request.kind === "preview" &&
				count(request.offset) &&
				count(request.total) &&
				count(request.limit) &&
				request.limit >= 1 &&
				request.limit <= MAX_PREVIEW_ROWS;
}

/** Executes only the fixed analytical worker; inputs and results never become shell code. */
export async function runAnalytical(
	request: AnalyticalRequest,
	onProgress?: (progress: { bytesProcessed: number; rowCount: number }) => void,
	signal?: AbortSignal,
): Promise<AnalyticalResult> {
	const started = Date.now();
	if (signal?.aborted) throw new AnalyticalProcessError(CANCELLED_ERROR);
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (process.platform !== "win32" || process.arch !== "x64" || major < 22 || (major === 22 && minor < 19))
		throw new AnalyticalProcessError(ISOLATION_ERROR);
	if (!requestValid(request)) throw new AnalyticalProcessError("Analytical worker request is invalid.");
	const encoded = JSON.stringify(request);
	if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
		throw new AnalyticalProcessError("Analytical worker request is invalid.");
	const windowsRoot = process.env.SystemRoot;
	if (!windowsRoot || !isAbsolute(windowsRoot)) throw new AnalyticalProcessError(ISOLATION_ERROR);
	let controlDirectory: string | undefined;
	let result: AnalyticalResult | undefined;
	let failure: AnalyticalProcessError | undefined;
	try {
		controlDirectory = await mkdtemp(join(tmpdir(), "pi-analytical-"));
		const requestPath = join(controlDirectory, "request.json");
		await writeFile(requestPath, encoded, { flag: "wx", mode: 0o600 });
		if (signal?.aborted) throw new AnalyticalProcessError(CANCELLED_ERROR);
		const remaining = PROCESSING_TIMEOUT_MS - (Date.now() - started);
		if (remaining <= 0) throw new AnalyticalProcessError(TIMEOUT_ERROR);
		const directory = controlDirectory;
		result = await new Promise<AnalyticalResult>((resolve, reject) => {
			const child = spawn(
				join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					fileURLToPath(new URL("./windows-worker.ps1", import.meta.url)),
					"-NodePath",
					process.execPath,
					"-RequestPath",
					requestPath,
					"-TimeoutMilliseconds",
					String(remaining),
				],
				{
					cwd: directory,
					windowsHide: true,
					shell: false,
					stdio: ["pipe", "pipe", "ignore"],
					env: {
						SystemRoot: windowsRoot,
						WINDIR: windowsRoot,
						PATH: join(windowsRoot, "System32"),
						TEMP: directory,
						TMP: directory,
						USERPROFILE: directory,
						HOME: directory,
						APPDATA: directory,
						LOCALAPPDATA: directory,
						PSModulePath: join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
					},
				},
			);
			let failure: AnalyticalProcessError | undefined;
			let terminal: AnalyticalResult | string | undefined;
			let receivedBytes = 0;
			let progressBytes = 0;
			let lineBytes = 0;
			let fragments: Buffer[] = [];
			let previousBytes = 0;
			let previousRows = 0;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const stop = (message: string) => {
				if (failure) return;
				failure = new AnalyticalProcessError(message);
				fragments = [];
				child.stdin.end(); // EOF is the helper's cancellation/parent-death control channel.
				killTimer = setTimeout(() => child.kill(), 6000);
			};
			const abort = () => stop(CANCELLED_ERROR);
			const timeout = setTimeout(() => stop(TIMEOUT_ERROR), remaining);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			child.stdin.on("error", () => stop(PROCESS_ERROR));
			child.on("error", () => stop(ISOLATION_ERROR));
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const consume = (line: Buffer) => {
				if (terminal !== undefined || line.length === 0) throw new AnalyticalProcessError(PROTOCOL_ERROR);
				const message: unknown = JSON.parse(decoder.decode(line));
				if (!record(message)) throw new AnalyticalProcessError(PROTOCOL_ERROR);
				if (message.type === "progress") {
					progressBytes += line.length + 1;
					if (
						!keys(message, ["type", "bytesProcessed", "rowCount"]) ||
						!count(message.bytesProcessed) ||
						!count(message.rowCount) ||
						message.bytesProcessed < previousBytes ||
						message.rowCount < previousRows ||
						message.bytesProcessed > (request.kind === "ingest" ? request.expectedByteSize : MAX_UPLOAD_BYTES) ||
						progressBytes > MAX_PROGRESS_BYTES
					)
						throw new AnalyticalProcessError(PROTOCOL_ERROR);
					previousBytes = message.bytesProcessed;
					previousRows = message.rowCount;
					onProgress?.({ bytesProcessed: previousBytes, rowCount: previousRows });
				} else if (
					message.type === "result" &&
					keys(message, ["type", "result"]) &&
					resultMatches(message.result, request)
				) {
					terminal = message.result;
				} else if (
					message.type === "error" &&
					keys(message, ["type", "error"]) &&
					typeof message.error === "string" &&
					safeWorkerErrors.has(message.error)
				) {
					terminal = message.error;
				} else throw new AnalyticalProcessError(PROTOCOL_ERROR);
			};
			child.stdout.on("data", (chunk: Buffer) => {
				if (failure) return;
				receivedBytes += chunk.length;
				if (receivedBytes > MAX_MESSAGE_BYTES + MAX_PROGRESS_BYTES) return stop(PROTOCOL_ERROR);
				try {
					let start = 0;
					while (start < chunk.length) {
						const newline = chunk.indexOf(10, start);
						const end = newline === -1 ? chunk.length : newline;
						const piece = chunk.subarray(start, end);
						lineBytes += piece.length;
						if (lineBytes > MAX_MESSAGE_BYTES) throw new AnalyticalProcessError(PROTOCOL_ERROR);
						fragments.push(piece);
						if (newline === -1) break;
						consume(fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, lineBytes));
						fragments = [];
						lineBytes = 0;
						start = newline + 1;
					}
				} catch {
					stop(PROTOCOL_ERROR);
				}
			});
			child.stdout.on("error", () => stop(PROCESS_ERROR));
			child.once("close", (code, exitSignal) => {
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				child.stdin.destroy();
				if (failure) return reject(failure);
				if (code === 120) return reject(new AnalyticalProcessError(ISOLATION_ERROR));
				if (code === 121) return reject(new AnalyticalProcessError(TIMEOUT_ERROR));
				if (code === 122) return reject(new AnalyticalProcessError(CANCELLED_ERROR));
				if (exitSignal || (code !== 0 && code !== 1)) return reject(new AnalyticalProcessError(PROCESS_ERROR));
				if (lineBytes || terminal === undefined) return reject(new AnalyticalProcessError(PROTOCOL_ERROR));
				if (typeof terminal === "string") {
					return reject(new AnalyticalProcessError(code === 1 ? terminal : PROTOCOL_ERROR));
				}
				if (code !== 0) return reject(new AnalyticalProcessError(PROCESS_ERROR));
				resolve(terminal);
			});
		});
	} catch (error) {
		failure =
			error instanceof AnalyticalProcessError
				? error
				: new AnalyticalProcessError(
						"Could not start analytical processing; check available disk space and permissions.",
					);
	}
	if (controlDirectory) {
		try {
			await rm(controlDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			failure ??= new AnalyticalProcessError("Could not remove analytical temporary files; check disk permissions.");
		}
	}
	if (failure) throw failure;
	if (!result) throw new AnalyticalProcessError(PROTOCOL_ERROR);
	return result;
}
