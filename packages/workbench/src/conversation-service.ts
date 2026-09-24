import { createHash, randomUUID } from "node:crypto";
import { buildConversationPayload, prepareAssistantContext } from "./assistant-context.ts";
import type { AssistantUsage } from "./assistant-contracts.ts";
import { parseAssistantSelection } from "./assistant-validation.ts";
import type { Dataset } from "./contracts.ts";
import {
	CONVERSATION_MESSAGE_BYTES,
	CONVERSATION_TRANSCRIPT_BYTES,
	type Conversation,
	type ConversationDriver,
	type ConversationEvent,
} from "./conversation-contracts.ts";
import type { DatasetProfile } from "./profile-contracts.ts";
import { WorkbenchError, type WorkbenchStore } from "./storage.ts";

const EMPTY_USAGE: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
type Store = Pick<
	WorkbenchStore,
	| "getProject"
	| "getDataset"
	| "getProfile"
	| "listCharts"
	| "transformHistory"
	| "conversations"
	| "conversation"
	| "putConversation"
	| "conversationSessionDir"
>;
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function mergeUsage(previous: AssistantUsage, next: AssistantUsage): AssistantUsage {
	return {
		input: Math.max(previous.input, next.input),
		output: Math.max(previous.output, next.output),
		cacheRead: Math.max(previous.cacheRead, next.cacheRead),
		cacheWrite: Math.max(previous.cacheWrite, next.cacheWrite),
		totalTokens: Math.max(previous.totalTokens, next.totalTokens),
	};
}

/** Application owns disclosure scope; Pi owns persisted conversation message history. */
export class ConversationService {
	readonly #store: Store;
	readonly #driver: ConversationDriver;
	readonly #active = new Map<string, AbortController>();
	readonly #events = new Map<string, ConversationEvent[]>();
	#closed = false;
	constructor(store: Store, driver: ConversationDriver) {
		this.#store = store;
		this.#driver = driver;
	}
	#open(): void {
		if (this.#closed) throw new WorkbenchError(503, "Assistant is shutting down.");
	}
	async #profile(projectId: string, dataset: Dataset): Promise<DatasetProfile> {
		const profile = await this.#store.getProfile(projectId, dataset.id);
		if (!profile || profile.datasetVersionId !== dataset.currentVersionId)
			throw new WorkbenchError(409, "Compute a current dataset profile before starting a conversation.");
		return profile;
	}
	async create(projectId: string, datasetId: string, value: unknown): Promise<Conversation> {
		this.#open();
		const dataset = await this.#store.getDataset(projectId, datasetId);
		const selection = parseAssistantSelection(value, dataset);
		const profile = await this.#profile(projectId, dataset);
		const context = prepareAssistantContext(
			this.#store.getProject(projectId),
			dataset,
			profile,
			await this.#store.listCharts(projectId, datasetId),
			selection,
			selection.executionIds?.length ? (await this.#store.transformHistory(projectId, datasetId)).records : [],
		);
		buildConversationPayload(context, selection.request);
		const now = new Date().toISOString();
		const conversation: Conversation = {
			id: randomUUID(),
			projectId,
			datasetId,
			createdAt: now,
			title: "New chat",
			archivedAt: null,
			updatedAt: now,
			state: "ready",
			sessionFile: null,
			scope: {
				version: 1,
				projectId,
				datasetId,
				datasetVersionId: dataset.currentVersionId,
				provider: selection.provider,
				modelId: selection.modelId,
				context,
				contextHash: hash(context),
				grantedAt: now,
			},
			messages: [],
			usage: { ...EMPTY_USAGE },
			error: null,
		};
		await this.#store.putConversation(conversation);
		return structuredClone(conversation);
	}
	async list(projectId: string, datasetId: string): Promise<Conversation[]> {
		this.#open();
		return (await this.#store.conversations(projectId, datasetId)).filter(
			(conversation) => conversation.archivedAt === null,
		);
	}
	async rename(projectId: string, datasetId: string, id: string, title: string): Promise<Conversation> {
		const conversation = await this.#store.conversation(projectId, datasetId, id);
		if (typeof title !== "string" || !title.trim() || title.length > 120)
			throw new WorkbenchError(400, "Use a chat title up to 120 characters.");
		conversation.title = title.trim();
		conversation.updatedAt = new Date().toISOString();
		await this.#store.putConversation(conversation);
		return conversation;
	}
	async archive(projectId: string, datasetId: string, id: string): Promise<void> {
		const conversation = await this.#store.conversation(projectId, datasetId, id);
		conversation.archivedAt = new Date().toISOString();
		conversation.updatedAt = conversation.archivedAt;
		await this.#store.putConversation(conversation);
	}
	get(projectId: string, datasetId: string, id: string): Promise<Conversation> {
		this.#open();
		return this.#store.conversation(projectId, datasetId, id);
	}
	async events(projectId: string, datasetId: string, id: string): Promise<ConversationEvent[]> {
		await this.#store.conversation(projectId, datasetId, id);
		const conversation = this.#events.get(id);
		return conversation ? structuredClone(conversation) : [];
	}
	async send(
		projectId: string,
		datasetId: string,
		id: string,
		value: unknown,
		onEvent?: (event: ConversationEvent) => void,
	): Promise<Conversation> {
		this.#open();
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).length !== 1 ||
			!("message" in value)
		)
			throw new WorkbenchError(400, "Write a message up to 16 KiB.");
		const message = value.message;
		if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > CONVERSATION_MESSAGE_BYTES)
			throw new WorkbenchError(400, "Write a message up to 16 KiB.");
		const conversation = await this.#store.conversation(projectId, datasetId, id);
		if (conversation.state === "running") throw new WorkbenchError(409, "This conversation is already responding.");
		if (Buffer.byteLength(JSON.stringify(conversation.messages)) > CONVERSATION_TRANSCRIPT_BYTES)
			throw new WorkbenchError(409, "Conversation history reached its limit. Start a new conversation to continue.");
		const dataset = await this.#store.getDataset(projectId, datasetId);
		if (dataset.currentVersionId !== conversation.scope.datasetVersionId)
			throw new WorkbenchError(
				409,
				"This conversation is attached to an older dataset version. Start a new conversation to share the current version.",
			);
		const payload = buildConversationPayload(conversation.scope.context, message.trim());
		if (conversation.sessionFile) payload.user = message.trim();
		if (conversation.title === "New chat") conversation.title = message.trim().slice(0, 120);
		const controller = new AbortController();
		this.#active.set(id, controller);
		const now = new Date().toISOString();
		const messageId = randomUUID();
		conversation.messages.push({
			id: messageId,
			role: "user",
			text: message.trim(),
			createdAt: now,
			state: "complete",
		});
		conversation.state = "running";
		conversation.error = null;
		conversation.updatedAt = now;
		await this.#store.putConversation(conversation);
		const buffer: ConversationEvent[] = [];
		this.#events.set(id, buffer);
		const emit = (event: ConversationEvent): void => {
			buffer.push(event);
			onEvent?.(event);
		};
		emit({ type: "status", conversationId: id, state: "running", error: null });
		try {
			const result = await this.#driver.chat(
				{
					provider: conversation.scope.provider,
					modelId: conversation.scope.modelId,
					sessionFile: conversation.sessionFile,
					sessionDir: await this.#store.conversationSessionDir(projectId, datasetId),
					system: payload.system,
					user: payload.user,
				},
				(event) => {
					emit({ type: "text", conversationId: id, messageId, delta: event.delta });
				},
				controller.signal,
			);
			conversation.messages.push({
				id: randomUUID(),
				role: "assistant",
				text: result.text,
				createdAt: new Date().toISOString(),
				state: "complete",
			});
			conversation.sessionFile = result.sessionFile;
			conversation.usage = mergeUsage(conversation.usage, result.usage);
			conversation.state = "ready";
			conversation.error = null;
		} catch (error) {
			conversation.state = "failed";
			conversation.error = controller.signal.aborted
				? "Assistant response was cancelled. You can send another message."
				: error instanceof WorkbenchError
					? error.message
					: "Assistant response failed. You can send another message.";
			conversation.messages[conversation.messages.length - 1]!.state = controller.signal.aborted
				? "cancelled"
				: "failed";
		} finally {
			conversation.updatedAt = new Date().toISOString();
			this.#active.delete(id);
			emit({ type: "status", conversationId: id, state: conversation.state, error: conversation.error });
			await this.#store.putConversation(conversation);
		}
		return structuredClone(conversation);
	}
	async cancel(projectId: string, datasetId: string, id: string): Promise<Conversation> {
		const conversation = await this.#store.conversation(projectId, datasetId, id);
		this.#active.get(id)?.abort();
		return conversation;
	}
	async close(): Promise<void> {
		this.#closed = true;
		for (const controller of this.#active.values()) controller.abort();
		await this.#driver.close();
	}
}
