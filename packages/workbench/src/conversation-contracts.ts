import type { AssistantContext, AssistantUsage } from "./assistant-contracts.ts";
import type { ChartRecord, ChartResult, ChartSpec } from "./chart-contracts.ts";

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

export interface RenameProposalInput {
	toolCallId: string;
	datasetVersionId: string;
	column: number;
	name: string;
}

export interface RenameProposal {
	id: string;
	projectId: string;
	datasetId: string;
	conversationId: string;
	toolCallId: string;
	inputVersionId: string;
	column: number;
	oldName: string;
	name: string;
	state: "proposed" | "previewing" | "previewed" | "applying" | "applied" | "rejected" | "failed" | "stale";
	createdAt: string;
	updatedAt: string;
	preview: {
		id: string;
		expiresAt: string;
		sql: string;
		inputRows: number;
		outputRows: number;
		affectedRows: number;
	} | null;
	outputVersionId: string | null;
	error: string | null;
	audit: {
		at: string;
		action: "proposed" | "preview_requested" | "previewed" | "approved" | "applied" | "rejected" | "failed" | "stale";
		actor: "pi" | "local-user" | "system";
	}[];
}

export interface ConversationRenameScope {
	datasetVersionId: string;
	columns: { index: number; name: string }[];
}

export interface ChartProposalInput {
	toolCallId: string;
	title: string;
	explanation: string;
	confidence: number;
	evidenceRefs: string[];
	affectedColumns: number[];
	spec: ChartSpec;
}

export interface ChartProposal extends ChartProposalInput {
	id: string;
	projectId: string;
	datasetId: string;
	conversationId: string;
	inputVersionId: string;
	basis: "evidence-linked" | "hypothesis";
	state: "proposed" | "previewing" | "previewed" | "saved" | "rejected" | "failed" | "stale";
	createdAt: string;
	updatedAt: string;
	preview: {
		id: string;
		expiresAt: string;
		datasetVersionHash: string;
		specHash: string;
		populationRows: number;
		sampleSize: number;
		sampled: boolean;
	} | null;
	chartId: string | null;
	error: string | null;
	audit: {
		at: string;
		action: "proposed" | "preview_requested" | "previewed" | "approved" | "saved" | "rejected" | "failed" | "stale";
		actor: "pi" | "local-user" | "system";
	}[];
}

export interface ConversationChartPreview {
	proposal: ChartProposal;
	chart: ChartResult;
}

export interface ConversationChartSaved {
	proposal: ChartProposal;
	chart: ChartRecord;
}

export type ConversationDriverEvent =
	| { type: "text"; delta: string }
	| ({ type: "rename_proposal" } & RenameProposalInput)
	| ({ type: "chart_proposal" } & ChartProposalInput);

export interface ConversationDriver {
	chat(
		input: {
			provider: string;
			modelId: string;
			sessionFile: string | null;
			sessionDir: string;
			system: string;
			user: string;
			renameScope?: ConversationRenameScope;
			chartScope?: AssistantContext;
		},
		onEvent: (event: ConversationDriverEvent) => void,
		signal: AbortSignal,
	): Promise<{ sessionFile: string; text: string; usage: AssistantUsage }>;
	setCredential(provider: unknown, apiKey: unknown): Promise<void>;
	deleteCredential(provider: string): Promise<void>;
	close(): Promise<void>;
}
