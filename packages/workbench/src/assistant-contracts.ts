import type { ChartFilter, ChartResult, ChartSpec } from "./chart-contracts.ts";
import type { DatasetColumn } from "./contracts.ts";
import type { TransformRecord, TransformSpec } from "./transform-contracts.ts";

export const ASSISTANT_CONTEXT_BYTES = 96 * 1024;
export const ASSISTANT_OUTPUT_BYTES = 128 * 1024;
export const ASSISTANT_MAX_SUGGESTIONS = 12;
export const ASSISTANT_TIMEOUT_MS = 5 * 60_000;
export const ASSISTANT_ATTACHMENT_MAX_FILES = 8;
export const ASSISTANT_ATTACHMENT_FILE_BYTES = 8192;
export const ASSISTANT_ATTACHMENT_TOTAL_BYTES = 32768;
export const SUGGESTION_CATEGORIES = [
	"data-quality",
	"exploration",
	"visualization",
	"transformation",
	"modeling",
	"interpretation",
] as const;
export const SUGGESTION_STATUSES = ["proposed", "accepted", "rejected", "applied", "failed", "reverted"] as const;
export interface AssistantModel {
	provider: string;
	id: string;
	name: string;
	configured: boolean;
	contextWindow: number;
}
export interface AssistantModels {
	models: AssistantModel[];
	guidance: string;
}
export interface AssistantAttachmentInput {
	name: string;
	mediaType: string;
	content: string;
}
export interface AssistantAttachment extends AssistantAttachmentInput {
	byteLength: number;
	sha256: string;
}
export interface AssistantExecutionReference {
	id: string;
	projectId: string;
	datasetId: string;
	state: TransformRecord["state"];
	inputVersionId: string;
	outputVersionId: string | null;
	kind: TransformSpec["operation"]["kind"];
	createdAt: string;
	completedAt: string | null;
	impact: {
		inputRows?: number;
		outputRows?: number;
		affectedRows?: number;
		inputColumnCount?: number;
		outputColumnCount?: number;
	} | null;
}
export interface AssistantSelection {
	datasetVersionId: string;
	selectedColumns: number[];
	filters: ChartFilter[];
	request: string;
	provider: string;
	modelId: string;
	attachments?: AssistantAttachmentInput[];
	executionIds?: string[];
}
export interface AssistantEvidence {
	id: string;
	metric: string;
	value: number | string | null;
	columns: number[];
	basis: "full" | "sample";
	rows: number;
	approximate: boolean;
}
export interface AssistantContext {
	version: 1;
	project: { id: string; name: string; description: string };
	dataset: {
		id: string;
		name: string;
		versionId: string;
		artifactHash: string;
		rowCount: number;
		columnCount: number;
	};
	schema: DatasetColumn[];
	selectedColumns: number[];
	filters: ChartFilter[];
	evidence: AssistantEvidence[];
	artifacts: { id: string; name: string; type: string; datasetVersionId: string }[];
	attachedFiles?: AssistantAttachment[];
	executionResults?: AssistantExecutionReference[];
	limitations: string[];
	rowsIncluded: false;
}
export interface AssistantPayload {
	system: string;
	user: string;
}
export interface AssistantDraft {
	id: string;
	projectId: string;
	datasetId: string;
	provider: string;
	modelId: string;
	createdAt: string;
	expiresAt: string;
	payloadHash: string;
	payload: AssistantPayload;
	context: AssistantContext;
}
export interface AssistantSuggestion {
	id: string;
	category: (typeof SUGGESTION_CATEGORIES)[number];
	title: string;
	explanation: string;
	priority: "low" | "medium" | "high";
	confidence: number;
	evidenceRefs: string[];
	affectedColumns: number[];
	proposedAction:
		| { kind: "chart"; spec: ChartSpec }
		| { kind: "transform"; spec: TransformSpec }
		| { kind: "read-only"; description: string };
	generatedCode: string | null;
	status: (typeof SUGGESTION_STATUSES)[number];
	basis: "evidence-linked" | "hypothesis";
	chartId: string | null;
	error: string | null;
}
export interface AssistantOutput {
	summary: string;
	suggestions: AssistantSuggestion[];
}
export interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}
export interface AssistantRun {
	id: string;
	projectId: string;
	datasetId: string;
	datasetVersionId: string;
	provider: string;
	modelId: string;
	createdAt: string;
	updatedAt: string;
	state: "running" | "completed" | "cancelled" | "failed";
	request: string;
	context: AssistantContext;
	payloadHash: string;
	summary: string;
	suggestions: AssistantSuggestion[];
	usage: AssistantUsage;
	latencyMs: number;
	receivedCharacters: number;
	error: string | null;
}
export type AssistantProgress =
	| { type: "progress"; receivedCharacters: number }
	| { type: "usage"; usage: AssistantUsage };
export interface AssistantDriver {
	models(signal?: AbortSignal): Promise<AssistantModels>;
	generate(
		input: { provider: string; modelId: string; payload: AssistantPayload },
		onProgress: (progress: AssistantProgress) => void,
		signal: AbortSignal,
	): Promise<{ text: string; usage: AssistantUsage }>;
}
export interface AssistantChartPreview {
	previewId: string;
	chart: ChartResult;
}
