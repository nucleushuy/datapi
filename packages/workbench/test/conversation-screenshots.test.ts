import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AssistantContext } from "../src/assistant-contracts.ts";
import { conversationContextHash, parseConversationScreenshots } from "../src/conversation-screenshots.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const screenshot = { name: "pasted.png", mediaType: "image/png", data: png };

test("screenshots require explicit consent and seal exactly the approved binary bytes", () => {
	assert.throws(() => parseConversationScreenshots([screenshot], false), /consent/);
	assert.throws(() => parseConversationScreenshots([screenshot], undefined), /consent/);
	const [parsed] = parseConversationScreenshots([screenshot], true);
	assert.equal(parsed.byteLength, 68);
	assert.equal(parsed.sha256, createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"));
	assert.equal(parsed.data, png);
	const context = { version: 1, rowsIncluded: false } as AssistantContext;
	assert.equal(conversationContextHash(context), createHash("sha256").update(JSON.stringify(context)).digest("hex"));
	assert.notEqual(conversationContextHash(context, [parsed]), conversationContextHash(context));
	assert.notEqual(
		conversationContextHash(context, [parsed]),
		conversationContextHash(context, [{ ...parsed, data: `${png}A` }]),
	);
});

test("screenshots reject forged MIME, malformed containers, unsafe names, noncanonical base64 and excess disclosure", () => {
	for (const input of [
		{ ...screenshot, mediaType: "image/jpeg" },
		{ ...screenshot, mediaType: "image/svg+xml" },
		{ ...screenshot, data: Buffer.from("<svg onload='alert(1)'/>").toString("base64") },
		{ ...screenshot, data: Buffer.from(Buffer.from(png, "base64").subarray(0, 40)).toString("base64") },
		{ ...screenshot, data: `${png}\n` },
		{ ...screenshot, data: `${png}AAAA` },
		{ ...screenshot, name: "../image.png" },
		{ ...screenshot, approved: true },
	])
		assert.throws(() => parseConversationScreenshots([input], true));
	const corrupt = Buffer.from(png, "base64");
	corrupt[45] ^= 1;
	assert.throws(
		() => parseConversationScreenshots([{ ...screenshot, data: corrupt.toString("base64") }], true),
		/bytes/,
	);
	assert.throws(
		() =>
			parseConversationScreenshots(
				Array.from({ length: 5 }, () => screenshot),
				true,
			),
		/four screenshots/,
	);
	assert.throws(() =>
		parseConversationScreenshots(
			[{ ...screenshot, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }],
			true,
		),
	);
});
