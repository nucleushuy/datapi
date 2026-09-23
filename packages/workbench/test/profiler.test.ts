import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ColumnProfiler, finiteNumber } from "../src/profiler.ts";

describe("finite numeric inference", () => {
	it("accepts finite decimal and exponent syntax without coercing whitespace or other bases", () => {
		for (const [text, expected] of [
			["001", 1],
			["+4", 4],
			["-2.5", -2.5],
			[".125", 0.125],
			["1.", 1],
			["4e2", 400],
			["-1E-2", -0.01],
			["0", 0],
			["1e-9999", 0],
		] as const)
			assert.equal(finiteNumber(text), expected);
		assert.ok(Object.is(finiteNumber("-0"), -0));
		for (const text of [
			"",
			" ",
			" 1",
			"1 ",
			"1\n",
			"0xff",
			"0b10",
			"NaN",
			"Infinity",
			"1e9999",
			"1,000",
			".",
			"1e",
			"true",
		]) {
			assert.equal(finiteNumber(text), null, `must not infer ${JSON.stringify(text)} as numeric`);
		}
	});

	it("counts all rows exactly and keeps numeric statistics for mixed columns", () => {
		const profiler = new ColumnProfiler(["numeric", "mixed", "boolean", "empty", "whitespace"]);
		profiler.add(["001", "-2", "true", "", " "]);
		profiler.add(["", "secret", "false", "", ""]);
		profiler.add(["-3.5", "4e2", "", "", "\t"]);
		assert.equal(profiler.rowCount, 3);
		assert.deepEqual(profiler.profiles(), [
			{ index: 0, name: "numeric", inferredType: "number", emptyCount: 1, numericCount: 2, min: -3.5, max: 1 },
			{ index: 1, name: "mixed", inferredType: "text", emptyCount: 0, numericCount: 2, min: -2, max: 400 },
			{ index: 2, name: "boolean", inferredType: "boolean", emptyCount: 1, numericCount: 0, min: null, max: null },
			{ index: 3, name: "empty", inferredType: "empty", emptyCount: 3, numericCount: 0, min: null, max: null },
			{ index: 4, name: "whitespace", inferredType: "text", emptyCount: 1, numericCount: 0, min: null, max: null },
		]);
	});

	it("infers header-only columns as empty and returns independent snapshots", () => {
		const profiler = new ColumnProfiler(["x"]);
		const before = profiler.profiles();
		assert.equal(before[0].inferredType, "empty");
		assert.equal(before[0].emptyCount, 0);
		before[0].name = "mutated";
		profiler.add(["TRUE"]);
		assert.equal(profiler.profiles()[0].name, "x");
		assert.equal(profiler.profiles()[0].inferredType, "text");
	});

	it("rejects inconsistent rows before mutating accumulated facts", () => {
		const profiler = new ColumnProfiler(["x", "y"]);
		profiler.add(["1", "2"]);
		const before = profiler.profiles();
		assert.throws(() => profiler.add(["private value"]), /column counts/);
		assert.equal(profiler.rowCount, 1);
		assert.deepEqual(profiler.profiles(), before);
	});
});
