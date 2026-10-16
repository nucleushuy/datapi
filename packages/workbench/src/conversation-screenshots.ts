import { createHash } from "node:crypto";
import type { AssistantContext } from "./assistant-contracts.ts";
import {
	CONVERSATION_SCREENSHOT_FILE_BYTES,
	CONVERSATION_SCREENSHOT_MAX_FILES,
	CONVERSATION_SCREENSHOT_TOTAL_BYTES,
	type ConversationScreenshot,
	type ConversationScreenshotInput,
} from "./conversation-contracts.ts";
import { WorkbenchError } from "./storage.ts";

function dimensions(width: number, height: number): boolean {
	return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216;
}

/** Inspect bounded binary containers, not filename extensions or browser MIME hints. */
function imageContainer(bytes: Buffer, mediaType: ConversationScreenshotInput["mediaType"]): boolean {
	if (mediaType === "image/png") {
		if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
		let offset = 8;
		let imageData = false;
		while (offset + 12 <= bytes.length) {
			const length = bytes.readUInt32BE(offset);
			const end = offset + 12 + length;
			if (end > bytes.length) return false;
			const type = bytes.toString("ascii", offset + 4, offset + 8);
			if (!/^[A-Za-z]{4}$/u.test(type)) return false;
			let crc = 0xffffffff;
			for (let index = offset + 4; index < end - 4; index++) {
				crc ^= bytes[index];
				for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
			}
			if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4)) return false;
			if (offset === 8 && (type !== "IHDR" || length !== 13)) return false;
			if (type === "IHDR") {
				if (offset !== 8 || !dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12)))
					return false;
				const depth = bytes[offset + 16];
				const color = bytes[offset + 17];
				if (
					!(
						color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [2, 4, 6].includes(color) ? [8, 16] : []
					).includes(depth)
				)
					return false;
				if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
			}
			if (type === "acTL") return false;
			if (type === "IDAT" && length > 0) imageData = true;
			if (type === "IEND") return length === 0 && end === bytes.length && imageData;
			offset = end;
		}
		return false;
	}
	if (mediaType === "image/jpeg") {
		if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
			return false;
		let offset = 2;
		let sized = false;
		let scan = false;
		while (offset < bytes.length) {
			if (bytes[offset++] !== 0xff) return false;
			while (bytes[offset] === 0xff) offset++;
			const marker = bytes[offset++];
			if (marker === 0xd9) return offset === bytes.length && sized && scan;
			if (marker === undefined || marker === 0 || marker === 0xd8 || offset + 2 > bytes.length) return false;
			const length = bytes.readUInt16BE(offset);
			if (length < 2 || offset + length > bytes.length) return false;
			if ([0xc0, 0xc1, 0xc2].includes(marker)) {
				if (length < 8 || !dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false;
				sized = true;
			}
			offset += length;
			if (marker === 0xda) {
				if (!sized) return false;
				scan = true;
				while (offset < bytes.length - 1) {
					if (bytes[offset] !== 0xff) {
						offset++;
						continue;
					}
					const next = bytes[offset + 1];
					if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
						offset += 2;
						continue;
					}
					break;
				}
			}
		}
		return false;
	}
	if (
		bytes.length < 20 ||
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WEBP" ||
		bytes.readUInt32LE(4) !== bytes.length - 8
	)
		return false;
	let offset = 12;
	let imageData = false;
	while (offset + 8 <= bytes.length) {
		const type = bytes.toString("ascii", offset, offset + 4);
		const length = bytes.readUInt32LE(offset + 4);
		const start = offset + 8;
		const end = start + length;
		if (end > bytes.length || type === "ANIM" || type === "ANMF") return false;
		if (type === "VP8 ") {
			if (
				imageData ||
				length < 10 ||
				(bytes[start] & 1) !== 0 ||
				bytes.toString("hex", start + 3, start + 6) !== "9d012a" ||
				!dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff)
			)
				return false;
			imageData = true;
		} else if (type === "VP8L") {
			if (imageData || length < 5 || bytes[start] !== 0x2f) return false;
			const bits = bytes.readUInt32LE(start + 1);
			if (bits >>> 29 !== 0 || !dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)) return false;
			imageData = true;
		} else if (type === "VP8X") {
			if (
				offset !== 12 ||
				length !== 10 ||
				(bytes[start] & 2) !== 0 ||
				!dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1)
			)
				return false;
		}
		offset = end + (length & 1);
	}
	return offset === bytes.length && imageData;
}

export function parseConversationScreenshots(value: unknown, consent: unknown): ConversationScreenshot[] {
	if (
		!Array.isArray(value) ||
		value.length > CONVERSATION_SCREENSHOT_MAX_FILES ||
		(value.length > 0 && consent !== true)
	)
		throw new WorkbenchError(
			400,
			"Explicitly consent before sharing up to four screenshots with the selected provider.",
		);
	let total = 0;
	return value.map((value: unknown) => {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Reflect.ownKeys(value).length !== 3 ||
			!("name" in value) ||
			!("mediaType" in value) ||
			!("data" in value) ||
			typeof value.name !== "string" ||
			!value.name.trim() ||
			value.name.length > 256 ||
			/[\\/\u0000-\u001f\u007f]/u.test(value.name) ||
			!["image/png", "image/jpeg", "image/webp"].includes(String(value.mediaType)) ||
			typeof value.data !== "string" ||
			value.data.length === 0 ||
			value.data.length > 4 * Math.ceil(CONVERSATION_SCREENSHOT_FILE_BYTES / 3) ||
			value.data.length % 4 !== 0 ||
			/[^A-Za-z0-9+/=]/u.test(value.data)
		)
			throw new WorkbenchError(
				400,
				"Screenshots require a safe name, PNG/JPEG/WebP MIME type and canonical base64 bytes.",
			);
		const bytes = Buffer.from(value.data, "base64");
		total += bytes.length;
		if (
			bytes.toString("base64") !== value.data ||
			bytes.length > CONVERSATION_SCREENSHOT_FILE_BYTES ||
			total > CONVERSATION_SCREENSHOT_TOTAL_BYTES
		)
			throw new WorkbenchError(413, "Screenshots must be at most 2 MiB each and 4 MiB total.");
		const mediaType = value.mediaType as ConversationScreenshot["mediaType"];
		if (!imageContainer(bytes, mediaType))
			throw new WorkbenchError(
				400,
				"Screenshot bytes must match a complete, non-animated PNG/JPEG/WebP image up to 8192 pixels per side and 16 megapixels.",
			);
		return {
			name: value.name,
			mediaType,
			data: value.data,
			byteLength: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	});
}

export function conversationContextHash(context: AssistantContext, screenshots?: ConversationScreenshot[]): string {
	return createHash("sha256")
		.update(JSON.stringify(screenshots?.length ? { context, screenshots } : context))
		.digest("hex");
}
