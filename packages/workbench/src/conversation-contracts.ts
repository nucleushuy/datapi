import type { AssistantContext, AssistantUsage } from "./assistant-contracts.ts";

export const CONVERSATION_MESSAGE_BYTES = 16 * 1024;
export const CONVERSATION_TRANSCRIPT_BYTES = 256 * 1024;

export interface ConversationScope {
	version: 1;
	projectId: string;
	datasetId: string;
	datasetVersionId: string;
	provider: string;
	modelId: string;
	context: AssistantContext;
	contextHash: string;
	grantedAt: string;
}

export interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	createdAt: string;
	state: "complete" | "cancelled" | "failed";
}

export interface Conversation {
	id: string;
	projectId: string;
	datasetId: string;
	createdAt: string;
	title: string;
	archivedAt: string | null;
	updatedAt: string;
	state: "ready" | "running" | "failed";
	sessionFile: string | null;
	scope: ConversationScope;
	messages: ConversationMessage[];
	usage: AssistantUsage;
	error: string | null;
}

export type ConversationEvent =
	| { type: "text"; conversationId: string; messageId: string; delta: string }
	| { type: "status"; conversationId: string; state: Conversation["state"]; error: string | null };

export type PiAgentEvent =
	| { type: "message"; conversationId: string; messageId: string; role: ConversationMessage["role"]; text: string }
	| { type: "status"; conversationId: string; state: Conversation["state"]; detail: string | null }
	| { type: "tool_request"; conversationId: string; toolCallId: string; operation: string; detail: string }
	| { type: "approval_required"; conversationId: string; toolCallId: string; operation: string; detail: string }
	| { type: "tool_result"; conversationId: string; toolCallId: string; detail: string }
	| { type: "error"; conversationId: string; message: string }
	| { type: "completed"; conversationId: string };

/** Browser-facing Pi boundary; tool approval remains limited to validated local operations. */
export interface PiAgentAdapter {
	createSession(input: unknown): Promise<Conversation>;
	listSessions(projectId: string, datasetId: string): Promise<Conversation[]>;
	renameSession(projectId: string, datasetId: string, id: string, title: string): Promise<Conversation>;
	archiveSession(projectId: string, datasetId: string, id: string): Promise<void>;
	streamAgentEvents(
		projectId: string,
		datasetId: string,
		id: string,
		onEvent: (event: PiAgentEvent) => void,
	): () => void;
	resumeRun(projectId: string, datasetId: string, id: string): Promise<Conversation>;
	getSessionAuditLog(projectId: string, datasetId: string, id: string): Promise<PiAgentEvent[]>;
	loadSession(projectId: string, datasetId: string, id: string): Promise<Conversation>;
	sendMessage(
		projectId: string,
		datasetId: string,
		id: string,
		input: unknown,
		onEvent: (event: PiAgentEvent) => void,
	): Promise<Conversation>;
	cancelRun(projectId: string, datasetId: string, id: string): Promise<Conversation>;
	approveToolCall(projectId: string, datasetId: string, id: string, toolCallId: string): Promise<void>;
	rejectToolCall(projectId: string, datasetId: string, id: string, toolCallId: string): Promise<void>;
}

export interface ConversationDriver {
	chat(
		input: {
			provider: string;
			modelId: string;
			sessionFile: string | null;
			sessionDir: string;
			system: string;
			user: string;
		},
		onEvent: (event: { type: "text"; delta: string }) => void,
		signal: AbortSignal,
	): Promise<{ sessionFile: string; text: string; usage: AssistantUsage }>;
	setCredential(provider: unknown, apiKey: unknown): Promise<void>;
	deleteCredential(provider: string): Promise<void>;
	close(): Promise<void>;
}
