import assert from "node:assert/strict";
import { test } from "node:test";
import { isAssistantUsage } from "../src/assistant-driver.ts";

test("usage accepts only complete nonnegative safe token counts", () => {
	const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };
	assert.equal(isAssistantUsage(usage), true);
	assert.equal(isAssistantUsage({ ...usage, totalTokens: Number.MAX_SAFE_INTEGER }), true);
	for (const invalid of [
		null,
		[],
		{ input: 7 },
		{ ...usage, input: -1 },
		{ ...usage, output: 1.5 },
		{ ...usage, cacheRead: Number.NaN },
		{ ...usage, cacheWrite: Infinity },
		{ ...usage, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
		{ ...usage, authorization: "not-public" },
	]) {
		assert.equal(isAssistantUsage(invalid), false);
	}
});
