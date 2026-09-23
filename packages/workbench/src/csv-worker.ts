import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parentPort, workerData } from "node:worker_threads";
import { CsvError, parse } from "csv-parse";
import { MAX_COLUMNS, MAX_RECORD_BYTES, MAX_UPLOAD_BYTES, PAGE_SIZE } from "./contracts.ts";
import type { CsvWorkerMessage, CsvWorkerRequest } from "./profiler.ts";
import { ColumnProfiler } from "./profiler.ts";

class CsvValidationError extends Error {}

async function processCsv(request: CsvWorkerRequest): Promise<void> {
	const hash = createHash("sha256");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let byteSize = 0;
	let fieldBytes = 0;
	let profiler: ColumnProfiler | undefined;
	let preview: FileHandle | undefined;
	let index: FileHandle | undefined;
	let previewBuffer = "";
	let previewBufferBytes = 0;
	let previewOffset = 0;
	const indexBuffer = Buffer.alloc(64 * 1024);
	let indexBytes = 0;
	let lastProgress = 0;
	const send = (message: CsvWorkerMessage): void => {
		parentPort?.postMessage(message);
	};
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
			if (typeof context.column !== "number" || context.column >= MAX_COLUMNS) {
				throw new CsvValidationError(`CSV cannot contain more than ${MAX_COLUMNS} columns.`);
			}
			fieldBytes += Buffer.byteLength(value, "utf8");
			if (fieldBytes > MAX_RECORD_BYTES) throw new CsvValidationError("CSV record exceeds the size limit.");
			return value;
		},
		on_record(record) {
			fieldBytes = 0;
			return record;
		},
	});
	try {
		if (request.writePreview) {
			preview = await open(join(request.stagingPath, "preview.jsonl"), "wx", 0o600);
			index = await open(join(request.stagingPath, "preview.idx"), "wx", 0o600);
		}
		await pipeline(
			createReadStream(request.sourcePath, { highWaterMark: 16 * 1024 }),
			async function* (source: AsyncIterable<Buffer>) {
				for await (const chunk of source) {
					byteSize += chunk.byteLength;
					if (byteSize > MAX_UPLOAD_BYTES) throw new CsvValidationError("CSV exceeds the 100 MB upload limit.");
					try {
						decoder.decode(chunk, { stream: true });
					} catch {
						throw new CsvValidationError("CSV must contain valid UTF-8 text.");
					}
					hash.update(chunk);
					yield chunk;
				}
				try {
					decoder.decode();
				} catch {
					throw new CsvValidationError("CSV must contain valid UTF-8 text.");
				}
			},
			parser,
			async (records: AsyncIterable<string[]>) => {
				for await (const record of records) {
					if (!profiler) {
						if (record.length === 0 || record.some((name) => name.trim().length === 0)) {
							throw new CsvValidationError("CSV requires a nonempty header for every column.");
						}
						if (new Set(record).size !== record.length) {
							throw new CsvValidationError("CSV column headers must be unique.");
						}
						profiler = new ColumnProfiler(record);
						continue;
					}
					if (preview && index) {
						if (profiler.rowCount % PAGE_SIZE === 0) {
							indexBuffer.writeBigUInt64LE(BigInt(previewOffset), indexBytes);
							indexBytes += 8;
							if (indexBytes === indexBuffer.length) {
								await index.writeFile(indexBuffer);
								indexBytes = 0;
							}
						}
						const line = `${JSON.stringify(record)}\n`;
						const bytes = Buffer.byteLength(line, "utf8");
						previewOffset += bytes;
						previewBuffer += line;
						previewBufferBytes += bytes;
						if (previewBufferBytes >= 64 * 1024) {
							await preview.writeFile(previewBuffer);
							previewBuffer = "";
							previewBufferBytes = 0;
						}
					}
					profiler.add(record);
					if (Date.now() - lastProgress >= 100) {
						send({ type: "progress", bytesProcessed: parser.info.bytes, rowCount: profiler.rowCount });
						lastProgress = Date.now();
					}
				}
			},
		);
		if (!profiler) throw new CsvValidationError("CSV is empty; a header row is required.");
		if (preview && index) {
			if (previewBufferBytes > 0) await preview.writeFile(previewBuffer);
			if (indexBytes > 0) await index.writeFile(indexBuffer.subarray(0, indexBytes));
			await preview.sync();
			await index.sync();
			await preview.close();
			preview = undefined;
			await index.close();
			index = undefined;
		}
		send({
			type: "result",
			result: { byteSize, sha256: hash.digest("hex"), rowCount: profiler.rowCount, columns: profiler.profiles() },
		});
	} finally {
		await preview?.close();
		await index?.close();
	}
}

if (parentPort) {
	void processCsv(workerData as CsvWorkerRequest).catch((error: unknown) => {
		let message = "CSV processing failed; check the file and available disk space.";
		if (error instanceof CsvValidationError) message = error.message;
		else if (error instanceof CsvError) {
			message =
				error.code === "CSV_MAX_RECORD_SIZE"
					? "CSV record exceeds the size limit."
					: "CSV is malformed; check quoting and consistent column counts.";
		}
		parentPort?.postMessage({ type: "error", error: message } satisfies CsvWorkerMessage);
	});
}
