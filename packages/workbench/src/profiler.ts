import type { ColumnProfile } from "./contracts.ts";

// Decimal/exponent syntax only: whitespace, hex and non-finite values remain text.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$(?![\s\S])/;

export function finiteNumber(value: string): number | null {
	if (!DECIMAL.test(value)) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

export class ColumnProfiler {
	readonly #columns: ColumnProfile[];
	readonly #booleanCounts: number[];
	#rowCount = 0;

	constructor(names: readonly string[]) {
		this.#columns = names.map((name, index) => ({
			index,
			name,
			inferredType: "empty",
			emptyCount: 0,
			numericCount: 0,
			min: null,
			max: null,
		}));
		this.#booleanCounts = names.map(() => 0);
	}

	add(row: readonly string[]): void {
		if (row.length !== this.#columns.length) throw new Error("CSV column counts do not match.");
		this.#rowCount++;
		for (let index = 0; index < row.length; index++) {
			const value = row[index];
			const column = this.#columns[index];
			if (value === "") {
				column.emptyCount++;
				continue;
			}
			if (value === "true" || value === "false") this.#booleanCounts[index]++;
			const number = finiteNumber(value);
			if (number !== null) {
				column.numericCount++;
				column.min = column.min === null ? number : Math.min(column.min, number);
				column.max = column.max === null ? number : Math.max(column.max, number);
			}
		}
	}

	get rowCount(): number {
		return this.#rowCount;
	}

	profiles(): ColumnProfile[] {
		return this.#columns.map((column, index) => {
			const nonempty = this.#rowCount - column.emptyCount;
			const inferredType =
				nonempty === 0
					? "empty"
					: column.numericCount === nonempty
						? "number"
						: this.#booleanCounts[index] === nonempty
							? "boolean"
							: "text";
			return { ...column, inferredType };
		});
	}
}

export interface CsvWorkerRequest {
	sourcePath: string;
	stagingPath: string;
	writePreview: boolean;
}

export interface CsvWorkerResult {
	byteSize: number;
	sha256: string;
	rowCount: number;
	columns: ColumnProfile[];
}

export type CsvWorkerMessage =
	| { type: "progress"; bytesProcessed: number; rowCount: number }
	| { type: "result"; result: CsvWorkerResult }
	| { type: "error"; error: string };
