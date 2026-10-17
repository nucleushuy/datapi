import { randomUUID } from "node:crypto";
import {
	type Context,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	type JsonValue,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantContext } from "../../src/assistant-contracts.ts";
import type { ChartSpec } from "../../src/chart-contracts.ts";
import { defaultChartSpec } from "../../src/chart-spec.ts";
import { chartColumns } from "../../src/chart-validation.ts";
import type { ChartProposalInput, ConversationDriver } from "../../src/conversation-contracts.ts";
import { PiConversationDriver } from "../../src/conversation-driver.ts";
import { ProviderService } from "../../src/provider-service.ts";
import { WorkbenchError } from "../../src/storage.ts";

export const FAUX_CONVERSATION_MODEL = {
	provider: "openai",
	id: "fixture",
	name: "Deterministic Pi fixture",
	contextWindow: 128000,
};

export function snapshotConversationContext(context: Context): Context {
	// SDK agent tools carry execute callbacks; a provider observes their public definitions only.
	return structuredClone({
		systemPrompt: context.systemPrompt ?? getCurrentSystemPrompt(context.messages),
		messages: context.messages.filter((message) => message.role !== "system"),
		tools: (context.tools ?? getCurrentTools(context.messages)).map(
			({ name, description, parameters, constrainedSampling }) => ({
				name,
				description,
				parameters,
				constrainedSampling,
			}),
		),
	});
}

/** Test-only native provider. No URL, API credential resolver, or network transport is installed. */
export async function createFauxConversationRuntime(
	options: { tokensPerSecond?: number; reasoning?: boolean; images?: boolean } = {},
) {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "openai",
		api: "openai-responses",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				maxTokens: 20000,
				contextWindow: 128000,
				reasoning: options.reasoning,
				input: options.images === false ? ["text"] : ["text", "image"],
			},
			{
				id: "fixture-second",
				name: "Second fixture",
				maxTokens: 20000,
				contextWindow: 128000,
				reasoning: options.reasoning,
				input: options.images === false ? ["text"] : ["text", "image"],
			},
		],
		tokenSize: { min: 16, max: 16 },
		tokensPerSecond: options.tokensPerSecond,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: ["openai"] });
	return { runtime, faux };
}

export type FauxConversationChart =
	| "auto"
	| {
			spec: ChartSpec;
			title?: string;
			explanation?: string;
			evidenceRefs?: string[];
			affectedColumns?: number[];
	  };

export function fauxConversationChart(scope: AssistantContext, option: FauxConversationChart = "auto") {
	const column =
		scope.schema.find((column) => column.basicType === "number") ??
		scope.schema.find((column) => column.basicType !== "binary" && column.basicType !== "nested");
	if (option === "auto" && !column) throw new Error("A disclosed scalar chart column is required.");
	const spec: ChartSpec =
		option === "auto"
			? {
					...defaultChartSpec(scope.dataset.versionId),
					type: column!.basicType === "number" ? "histogram" : "bar",
					x: column!.index,
					filters: scope.filters,
				}
			: option.spec;
	const affectedColumns =
		option !== "auto" && option.affectedColumns
			? [...option.affectedColumns]
			: chartColumns(spec, scope.schema).map((column) => column.index);
	const evidence = scope.evidence.find(
		(entry) => entry.columns.length > 0 && entry.columns.every((index) => affectedColumns.includes(index)),
	);
	return {
		title: option !== "auto" && option.title !== undefined ? option.title : "Explore the disclosed distribution",
		explanation:
			option !== "auto" && option.explanation !== undefined
				? option.explanation
				: "Inspect the distribution using only the frozen disclosed columns. Preview locally before deciding whether to save.",
		confidence: 0.8,
		evidenceRefs: option === "auto" ? (evidence ? [evidence.id] : []) : [...(option.evidenceRefs ?? [])],
		affectedColumns,
		spec: { ...spec, filters: spec.filters.map((filter) => ({ ...filter })) },
	} satisfies Omit<ChartProposalInput, "toolCallId"> & Record<string, JsonValue>;
}

export function fauxConversationChartScope(): AssistantContext {
	return {
		version: 1,
		project: { id: "project-1", name: "Frozen project", description: "" },
		dataset: {
			id: "dataset-1",
			name: "Frozen dataset",
			versionId: "v1",
			artifactHash: "a".repeat(64),
			rowCount: 20,
			columnCount: 3,
		},
		schema: [
			{ index: 0, name: "group", sourceType: "VARCHAR", basicType: "text" },
			{ index: 1, name: "value", sourceType: "DOUBLE", basicType: "number" },
		],
		selectedColumns: [0, 1],
		filters: [],
		evidence: [
			{
				id: "column.1.numeric.min",
				metric: "min",
				value: 1,
				columns: [1],
				basis: "full",
				rows: 20,
				approximate: false,
			},
		],
		artifacts: [],
		limitations: ["One private column is not disclosed."],
		rowsIncluded: false,
	};
}

export async function createFauxConversationDriver(
	dataDir: string,
	options: {
		tokensPerSecond?: number;
		reasoning?: boolean;
		images?: boolean;
		beforeResult?: () => Promise<void>;
		rename?: { column: number; name: string; datasetVersionId?: string };
		chart?: FauxConversationChart;
	} = {},
): Promise<FauxConversationFixture> {
	const { runtime, faux } = await createFauxConversationRuntime(options);
	const providers = await ProviderService.create(dataDir, { runtime });
	const production = new PiConversationDriver(providers);
	const seen: Context[] = [];
	const active = new Set<AbortController>();
	let closed = false;
	const driver: ConversationDriver = {
		modelState: (input) => production.modelState(input),
		selectModel: (input, selection) => production.selectModel(input, selection),
		draftModelState: () => production.draftModelState(),
		selectDraftModel: (selection) => production.selectDraftModel(selection),
		async chat(input, onEvent, signal) {
			if (closed) throw new WorkbenchError(503, "Assistant is closed.");
			const controller = new AbortController();
			active.add(controller);
			const combined = AbortSignal.any([signal, controller.signal]);
			try {
				const rename = options.rename;
				const chart = options.chart;
				if (rename || chart) {
					const chartArgs = chart ? fauxConversationChart(input.chartScope!, chart) : undefined;
					faux.appendResponses([
						(context) => {
							seen.push(snapshotConversationContext(context));
							return fauxAssistantMessage(
								[
									...(rename
										? [
												fauxToolCall(
													"propose_column_rename",
													{
														column: rename.column,
														name: rename.name,
														datasetVersionId:
															rename.datasetVersionId ??
															input.renameScope?.datasetVersionId ??
															"missing-scope",
													},
													{ id: randomUUID() },
												),
											]
										: []),
									...(chartArgs ? [fauxToolCall("propose_chart", chartArgs, { id: randomUUID() })] : []),
								],
								{ stopReason: "toolUse", timestamp: 0 },
							);
						},
						(context) => {
							seen.push(snapshotConversationContext(context));
							return fauxAssistantMessage(
								chart
									? "The chart is awaiting local review. Preview it locally, then explicitly save or reject. No chart or dataset change has been applied."
									: "The column rename is awaiting local review. Preview it, then approve and apply or reject. No dataset change has been applied.",
								{ timestamp: 1 },
							);
						},
					]);
				} else {
					faux.appendResponses([
						(context) => {
							seen.push(snapshotConversationContext(context));
							return fauxAssistantMessage(
								"Deterministic Pi streaming reply. Frozen dataset metadata and explicitly attached files remain read-only. No files or tools were executed.",
								{ timestamp: 0 },
							);
						},
					]);
				}
				const result = await production.chat(input, onEvent, combined);
				await options.beforeResult?.();
				if (combined.aborted) throw new WorkbenchError(499, "Assistant request was cancelled.");
				return result;
			} finally {
				active.delete(controller);
			}
		},
		async close() {
			closed = true;
			for (const controller of active) controller.abort();
			await production.close();
		},
	};
	return { driver, providers, seen, faux };
}

export interface FauxConversationFixture {
	driver: ConversationDriver;
	providers: ProviderService;
	seen: Context[];
	faux: FauxProviderHandle;
}
