import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("registers supported models via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("together", "MiniMaxAI/MiniMax-M2.7");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBeTruthy();
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBeGreaterThan(0);
		expect(model.maxTokens).toBeGreaterThan(0);
		expect(model.cost.input).toBeGreaterThanOrEqual(0);
		expect(model.cost.output).toBeGreaterThanOrEqual(0);
		expect(model.cost.cacheRead).toBeGreaterThanOrEqual(0);
		expect(model.cost.cacheWrite).toBeGreaterThanOrEqual(0);
		expect(model.compat?.supportsStore).toBe(false);
		expect(model.compat?.supportsDeveloperRole).toBe(false);
		expect(model.compat?.supportsReasoningEffort).toBe(false);
		expect(model.compat?.maxTokensField).toBe("max_tokens");
		expect(model.compat?.supportsStrictMode).toBe(false);
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const gptOss = getModel("together", "openai/gpt-oss-120b");
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const deepSeekV4 = getModel("together", "deepseek-ai/DeepSeek-V4-Pro");
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});

		const minimax = getModel("together", "MiniMaxAI/MiniMax-M2.7");
		expect(minimax.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(minimax.compat?.thinkingFormat).toBeUndefined();
		expect(minimax.compat?.supportsReasoningEffort).toBe(false);
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
