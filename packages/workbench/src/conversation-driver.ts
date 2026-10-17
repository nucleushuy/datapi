import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_TIMEOUT_MS } from "./assistant-contracts.ts";
import { ASSISTANT_WORKER_ERRORS } from "./assistant-driver.ts";
import { type DatasetColumn, MAX_COLUMNS } from "./contracts.ts";
import type {
	ConversationDriver,
	ConversationDriverInput,
	ConversationModelResult,
	RenameProposalInput,
} from "./conversation-contracts.ts";
import {
	type ControlledConversationSession,
	ConversationRuntimeFailure,
	conversationRequest,
	createConversationSession,
} from "./conversation-runtime.ts";
import { CONVERSATION_CWD, controlledConversationSession } from "./conversation-session.ts";
import type { SessionModelSelection, SessionModelState } from "./provider-contracts.ts";
import type { ProviderService } from "./provider-service.ts";
import { WorkbenchError } from "./storage.ts";
import { parseTransformSpec } from "./transform-spec.ts";

export const CONVERSATION_PROPOSAL_LIMIT = 8;
export type RenameProposalValidator = (value: unknown) => value is RenameProposalInput;

/** Validates only disclosed names; the server separately checks the complete, current schema. */
export function renameProposalValidator(scope: unknown): RenameProposalValidator | undefined {
	if (scope === undefined) return undefined;
	if (
		!record(scope) ||
		!keys(scope, ["datasetVersionId", "columns"]) ||
		typeof scope.datasetVersionId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,80}$/u.test(scope.datasetVersionId) ||
		!Array.isArray(scope.columns) ||
		scope.columns.length === 0 ||
		scope.columns.length > MAX_COLUMNS
	)
		throw error("request");
	const schema: DatasetColumn[] = [];
	const indexes = new Set<number>();
	for (const column of scope.columns) {
		if (
			!record(column) ||
			!keys(column, ["index", "name"]) ||
			typeof column.index !== "number" ||
			!Number.isSafeInteger(column.index) ||
			column.index < 0 ||
			column.index >= MAX_COLUMNS ||
			indexes.has(column.index) ||
			typeof column.name !== "string" ||
			column.name.includes("\0")
		)
			throw error("request");
		indexes.add(column.index);
		// Rename validation uses only index/name; these local type placeholders are never disclosed.
		schema.push({ index: column.index, name: column.name, sourceType: "", basicType: "text" });
	}
	const versionId = scope.datasetVersionId;
	return (value): value is RenameProposalInput => {
		if (
			!record(value) ||
			!keys(value, ["toolCallId", "datasetVersionId", "column", "name"]) ||
			typeof value.toolCallId !== "string" ||
			value.toolCallId.length === 0 ||
			value.toolCallId.length > 256 ||
			value.toolCallId.includes("\0")
		)
			return false;
		try {
			parseTransformSpec(
				{
					version: 1,
					datasetVersionId: value.datasetVersionId,
					operation: { kind: "rename", column: value.column, name: value.name },
				},
				schema,
				versionId,
			);
			return true;
		} catch {
			return false;
		}
	};
}

function error(code: keyof typeof ASSISTANT_WORKER_ERRORS): WorkbenchError {
	const status =
		code === "credentials"
			? 409
			: code === "cancelled"
				? 499
				: code === "timeout"
					? 504
					: code === "request" || code === "model" || code === "reasoning" || code === "images"
						? 400
						: 502;
	return new WorkbenchError(status, ASSISTANT_WORKER_ERRORS[code]);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
	return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
interface RetainedSession {
	controlled: ControlledConversationSession;
	fingerprint: string;
	checkpoint: string | null;
}

/** One real retained AgentSession per conversation, all sharing the profile runtime. */
export class PiConversationDriver implements ConversationDriver {
	readonly #providers: ProviderService;
	readonly #sessions = new Map<string, RetainedSession>();
	readonly #busy = new Set<string>();
	readonly #stoppers = new Set<AbortController>();
	readonly #pending = new Set<Promise<unknown>>();
	#draft: Promise<ControlledConversationSession> | undefined;
	#closed = false;
	constructor(providers: ProviderService) {
		this.#providers = providers;
	}

	async #operation<T>(key: string, action: () => Promise<T>): Promise<T> {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is closed.");
		if (this.#busy.has(key)) throw new WorkbenchError(409, "This Pi session is busy.");
		this.#busy.add(key);
		const task = Promise.resolve().then(action);
		this.#pending.add(task);
		try {
			return await task;
		} catch (cause) {
			if (cause instanceof WorkbenchError) throw cause;
			throw error(
				cause instanceof ConversationRuntimeFailure && Object.hasOwn(ASSISTANT_WORKER_ERRORS, cause.message)
					? (cause.message as keyof typeof ASSISTANT_WORKER_ERRORS)
					: "provider",
			);
		} finally {
			this.#busy.delete(key);
			this.#pending.delete(task);
		}
	}

	#key(input: ConversationDriverInput): string {
		return `${resolve(input.sessionDir)}:${input.conversationId ?? input.sessionFile ?? "new"}`;
	}

	async #retained(
		input: ConversationDriverInput,
		key: string,
		replacement?: SessionModelSelection,
	): Promise<RetainedSession> {
		conversationRequest(input);
		const fingerprint = JSON.stringify([input.system, input.mode, input.renameScope, input.chartScope]);
		const prior = this.#sessions.get(key);
		if (prior && prior.checkpoint === input.sessionFile && prior.fingerprint === fingerprint) return prior;
		if (prior) {
			await prior.controlled.session.abort();
			prior.controlled.session.dispose();
			this.#sessions.delete(key);
		}
		if (input.sessionFile) await controlledConversationSession(input.sessionFile, input.sessionDir);
		// Construction can append SDK metadata. Start on a fork, never mutate the published snapshot.
		const manager = input.sessionFile
			? SessionManager.forkFrom(input.sessionFile, CONVERSATION_CWD, input.sessionDir)
			: SessionManager.create(CONVERSATION_CWD, input.sessionDir);
		const controlled = await createConversationSession(this.#providers, input, manager, false, replacement);
		const retained = { controlled, fingerprint, checkpoint: input.sessionFile };
		this.#sessions.set(key, retained);
		return retained;
	}

	#checkpoint(retained: RetainedSession): string {
		const { session } = retained.controlled;
		const path = session.sessionFile;
		if (!path) throw error("provider");
		// Pi intentionally keeps selection-only setup entries in memory. Export through
		// its supported API so explicit selection survives restart before the first prompt.
		if (!existsSync(path)) session.exportToJsonl(path);
		session.sessionManager.setSessionFile(path);
		session.agent.sessionId = session.sessionManager.getSessionId();
		session.refreshContext();
		retained.checkpoint = path;
		return path;
	}

	#fork(retained: RetainedSession, input: ConversationDriverInput): void {
		const { session } = retained.controlled;
		const current = session.sessionFile;
		if (!current) throw error("provider");
		// Export setup entries before forking; no user message has been submitted yet.
		if (!existsSync(current)) session.exportToJsonl(current);
		const manager = SessionManager.forkFrom(current, CONVERSATION_CWD, input.sessionDir);
		const next = manager.getSessionFile();
		if (!next) throw error("provider");
		session.sessionManager.setSessionFile(next);
		session.agent.sessionId = session.sessionManager.getSessionId();
		session.refreshContext();
	}

	async #select(controlled: ControlledConversationSession, selection: SessionModelSelection): Promise<void> {
		const available = await this.#providers.runtime.getAvailable();
		if (!available.some((model) => model.provider === selection.provider && model.id === selection.modelId))
			throw error("model");
		const model = this.#providers.runtime.getModel(selection.provider, selection.modelId);
		if (!model) throw error("model");
		if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) throw error("reasoning");
		await controlled.session.setModel(model, { persist: selection.persist });
		controlled.session.setThinkingLevel(selection.thinkingLevel, { persist: selection.persist });
		if (selection.persist) {
			await this.#providers.settings.flush();
			if (this.#providers.settings.drainErrors().length)
				throw new WorkbenchError(500, "Pi could not save the default model settings.");
		}
	}

	modelState(input: ConversationDriverInput): Promise<ConversationModelResult> {
		const key = this.#key(input);
		return this.#operation(key, async () => {
			const retained = await this.#retained(input, key);
			return { modelState: retained.controlled.modelState(), sessionFile: this.#checkpoint(retained) };
		});
	}

	selectModel(input: ConversationDriverInput, selection: SessionModelSelection): Promise<ConversationModelResult> {
		const key = this.#key(input);
		return this.#operation(key, async () => {
			const retained = await this.#retained(input, key, selection);
			this.#fork(retained, input);
			try {
				await this.#select(retained.controlled, selection);
				return { modelState: retained.controlled.modelState(), sessionFile: this.#checkpoint(retained) };
			} catch (cause) {
				retained.checkpoint = null;
				retained.controlled.session.dispose();
				this.#sessions.delete(key);
				throw cause;
			}
		});
	}

	async #draftSession(): Promise<ControlledConversationSession> {
		this.#draft ??= createConversationSession(
			this.#providers,
			{
				provider: "",
				modelId: "",
				sessionDir: join(this.#providers.agentDir, "draft"),
				sessionFile: null,
				system: `Select a model. No dataset has been shared.\nCurrent working directory: ${CONVERSATION_CWD}\n`,
				user: "Select a model.",
				mode: "plan",
			},
			SessionManager.inMemory(CONVERSATION_CWD),
			true,
		).catch((cause) => {
			this.#draft = undefined;
			throw cause;
		});
		return this.#draft;
	}

	draftModelState(): Promise<SessionModelState> {
		return this.#operation("draft", async () => (await this.#draftSession()).modelState());
	}

	selectDraftModel(selection: SessionModelSelection): Promise<SessionModelState> {
		return this.#operation("draft", async () => {
			const controlled = await this.#draftSession();
			await this.#select(controlled, selection);
			return controlled.modelState();
		});
	}

	chat(
		input: ConversationDriverInput,
		onEvent: Parameters<ConversationDriver["chat"]>[1],
		signal: AbortSignal,
	): ReturnType<ConversationDriver["chat"]> {
		const key = this.#key(input);
		return this.#operation(key, async () => {
			if (signal.aborted) throw error("cancelled");
			const controller = new AbortController();
			const combined = AbortSignal.any([signal, controller.signal]);
			this.#stoppers.add(controller);
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, ASSISTANT_TIMEOUT_MS);
			let retained: RetainedSession | undefined;
			try {
				retained = await this.#retained(input, key);
				if (combined.aborted) throw error("cancelled");
				this.#fork(retained, input);
				const result = await retained.controlled.run(input, onEvent, combined);
				if (combined.aborted) throw error("cancelled");
				retained.checkpoint = result.sessionFile;
				return result;
			} catch (cause) {
				// The caller remains the publication authority. A failed candidate is never
				// reused, and a successful but rejected checkpoint is discarded on next input.
				if (retained) {
					await retained.controlled.session.abort();
					retained.controlled.session.dispose();
					this.#sessions.delete(key);
				}
				if (timedOut) throw error("timeout");
				throw cause;
			} finally {
				clearTimeout(timeout);
				this.#stoppers.delete(controller);
			}
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const controller of this.#stoppers) controller.abort();
		await Promise.allSettled(this.#pending);
		for (const { controlled } of this.#sessions.values()) {
			await controlled.session.abort();
			controlled.session.dispose();
		}
		this.#sessions.clear();
		const draft = await this.#draft?.catch(() => undefined);
		if (draft) {
			await draft.session.abort();
			draft.session.dispose();
		}
	}
}
