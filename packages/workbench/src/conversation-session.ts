import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkbenchError } from "./storage.ts";

export const CONVERSATION_CWD = process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant";

/** Only server-owned, regular JSONL files inside this dataset's session directory can be resumed or forked. */
export async function controlledConversationSession(source: string, directory: string): Promise<string> {
	const root = await realpath(directory);
	if (extname(source) !== ".jsonl" || resolve(dirname(source)) !== resolve(root))
		throw new WorkbenchError(409, "The saved Pi session is outside this dataset's controlled session directory.");
	const stat = await lstat(source);
	if (!stat.isFile() || stat.isSymbolicLink() || resolve(await realpath(source)) !== resolve(source))
		throw new WorkbenchError(409, "The saved Pi session is not a controlled regular file.");
	return source;
}

export async function duplicateConversationSession(source: string, directory: string): Promise<string> {
	await controlledConversationSession(source, directory);
	const manager = SessionManager.forkFrom(source, CONVERSATION_CWD, directory);
	const file = manager.getSessionFile();
	if (!file || resolve(file) === resolve(source))
		throw new WorkbenchError(500, "Pi could not create an independent session.");
	return file;
}
