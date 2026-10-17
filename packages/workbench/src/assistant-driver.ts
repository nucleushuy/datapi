import { ASSISTANT_CONTEXT_BYTES, type AssistantUsage } from "./assistant-contracts.ts";

export const ASSISTANT_REQUEST_BYTES = 8 * ASSISTANT_CONTEXT_BYTES;
/** Fixed public messages; SDK errors may contain credential-bearing provider responses. */
export const ASSISTANT_WORKER_ERRORS = {
	request: "Assistant request is invalid.",
	credentials: "Connect the selected provider in Providers before sending a message.",
	model: "The selected assistant model is unavailable.",
	images: "The selected model does not support screenshot images. Choose an image-capable model.",
	reasoning: "The selected model does not support this reasoning effort. Choose a supported effort before sending.",
	context: "Assistant session context did not match the approved payload.",
	provider: "The assistant provider could not complete this request. Check the connection and model in Providers.",
	output: "Assistant output exceeded its limit or was incomplete.",
	protocol: "Assistant returned an invalid response.",
	process: "Assistant stopped unexpectedly.",
	cancelled: "Assistant request was cancelled.",
	timeout: "Assistant request exceeded the five-minute limit.",
} as const;

export function isAssistantUsage(value: unknown): value is AssistantUsage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key)) &&
		Object.values(value).every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
	);
}
