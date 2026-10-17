import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_OUTPUT_BYTES } from "../../src/assistant-contracts.ts";
import { ASSISTANT_WORKER_ERRORS } from "../../src/assistant-driver.ts";
import type { ConversationDriverEvent, ConversationDriverInput } from "../../src/conversation-contracts.ts";
import { PiConversationDriver } from "../../src/conversation-driver.ts";
import { ProviderService } from "../../src/provider-service.ts";
import {
	createFauxConversationRuntime,
	fauxConversationChart,
	fauxConversationChartScope,
	snapshotConversationContext,
} from "./conversation-faux-driver.ts";

let networkCalls = 0;
globalThis.fetch = async () => {
	networkCalls++;
	throw new Error("Network is forbidden");
};
const root = await mkdtemp(join(tmpdir(), "pi-conversation-sdk-"));
const drivers = new Map<ModelRuntime, { driver: PiConversationDriver; providers: ProviderService }>();
async function registered(runtime: ModelRuntime) {
	let fixture = drivers.get(runtime);
	if (!fixture) {
		const providers = await ProviderService.create(join(root, `profile-${drivers.size}`), { runtime });
		fixture = { driver: new PiConversationDriver(providers), providers };
		drivers.set(runtime, fixture);
	}
	return fixture;
}
async function runConversationSession(
	input: unknown,
	onEvent: (event: ConversationDriverEvent) => void,
	signal: AbortSignal | undefined,
	runtime: ModelRuntime,
) {
	const { driver } = await registered(runtime);
	try {
		return await driver.chat(input as ConversationDriverInput, onEvent, signal ?? new AbortController().signal);
	} catch (cause) {
		if (cause instanceof Error) {
			const code = Object.entries(ASSISTANT_WORKER_ERRORS).find(([, message]) => message === cause.message)?.[0];
			if (code) throw new Error(code);
		}
		throw cause;
	}
}
try {
	const { runtime, faux } = await createFauxConversationRuntime();
	const frozen = JSON.stringify({
		dataset: { name: "Frozen dataset", rowsIncluded: false },
		attachedFiles: [{ name: "reference.sql", mediaType: "text/plain", content: "select 'snow 雪';\n" }],
		executionResults: [{ id: "execution-1", status: "completed", changedCells: 3 }],
	});
	const input = {
		provider: "openai",
		modelId: "fixture",
		sessionDir: join(root, "sessions"),
		sessionFile: null,
		system: `Read-only frozen context: ${frozen}\nCurrent working directory: ${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n`,
		user: "/skill:not-a-command {{literal user data}}",
	};
	const expectedSystemPrompt = `Read-only frozen context: ${frozen}\n\n<cwd>\n${process.platform === "win32" ? "C:/datapi-assistant" : "/datapi-assistant"}\n</cwd>`;
	let seen: Context | undefined;
	let maxTokens = 0;
	const answer = "A streaming response with Unicode 雪. ".repeat(8);
	faux.setResponses([
		(rawContext, streamOptions, _state, model) => {
			const context = snapshotConversationContext(rawContext);
			seen = snapshotConversationContext(context);
			maxTokens = streamOptions?.maxTokens ?? 0;
			assert.equal(model.maxTokens, 20000, "Exact runtime model is not cloned or capped");
			return fauxAssistantMessage(answer, { timestamp: 0 });
		},
	]);
	const events: string[] = [];
	const result = await runConversationSession(
		input,
		(event) => {
			if (event.type === "text") events.push(event.delta);
		},
		undefined,
		runtime,
	).then((value) => {
		events.push("FINAL");
		return value;
	});
	assert.ok(events.length > 2, "SDK must stream multiple deltas before completing");
	assert.equal(events.at(-1), "FINAL");
	assert.equal(events.slice(0, -1).join(""), answer);
	assert.equal(result.text, answer);
	assert.ok(result.usage.output > 0);
	assert.equal(maxTokens, 8192);
	assert.ok(seen);
	assert.equal(seen.systemPrompt, expectedSystemPrompt);
	assert.deepEqual(seen.tools ?? [], []);
	assert.equal(seen.messages.length, 1);
	assert.deepEqual(seen.messages[0].content, [{ type: "text", text: input.user }]);
	await access(result.sessionFile);
	const persisted = await readFile(result.sessionFile, "utf8");
	assert.ok(persisted.includes("literal user data"));

	// A fresh runtime and a reopened disk session, not an in-memory transcript imitation.
	const resumedRuntime = await createFauxConversationRuntime();
	let resumed: Context | undefined;
	resumedRuntime.faux.setResponses([
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			resumed = snapshotConversationContext(context);
			return fauxAssistantMessage("Follow-up answer", { timestamp: 1 });
		},
	]);
	const next = await runConversationSession(
		{ ...input, sessionFile: result.sessionFile, user: "Continue using the frozen context." },
		() => {},
		undefined,
		resumedRuntime.runtime,
	);
	assert.notEqual(next.sessionFile, result.sessionFile);
	assert.equal(await readFile(result.sessionFile, "utf8"), persisted);
	assert.ok(resumed);
	assert.equal(resumed.systemPrompt, expectedSystemPrompt);
	assert.deepEqual(resumed.tools ?? [], []);
	assert.equal(resumed.messages.length, 3);
	assert.deepEqual(
		resumed.messages.map((message) => message.role),
		["user", "assistant", "user"],
	);
	assert.deepEqual(resumed.messages[0].content, seen.messages[0].content);
	assert.deepEqual(resumed.messages[1].content, [{ type: "text", text: answer }]);
	assert.deepEqual(resumed.messages[2].content, [{ type: "text", text: "Continue using the frozen context." }]);

	const configured = await createFauxConversationRuntime({ reasoning: true });
	let receivedReasoning: unknown;
	configured.faux.setResponses([
		(rawContext, options) => {
			const context = snapshotConversationContext(rawContext);
			receivedReasoning = options?.reasoning;
			assert.deepEqual(context.tools ?? [], []);
			return fauxAssistantMessage("A read-only plan with explicit reasoning.");
		},
	]);
	await runConversationSession(
		{
			...input,
			mode: "plan",
			reasoningEffort: "high",
			renameScope: { datasetVersionId: "v1", columns: [{ index: 0, name: "group" }] },
			chartScope: fauxConversationChartScope(),
		},
		() => {},
		undefined,
		configured.runtime,
	);
	assert.equal(receivedReasoning, "high", "Requested reasoning reaches the actual provider adapter");
	const screenshot = {
		type: "image" as const,
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	};
	configured.faux.setResponses([
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			const content = context.messages.at(-1)?.content;
			assert.ok(Array.isArray(content));
			assert.deepEqual(
				content.filter((part) => part.type === "image"),
				[screenshot],
			);
			assert.equal(context.systemPrompt?.includes(screenshot.data), false);
			assert.equal(JSON.stringify(content.filter((part) => part.type === "text")).includes(screenshot.data), false);
			return fauxAssistantMessage("The explicitly shared screenshot is available.");
		},
	]);
	await runConversationSession({ ...input, images: [screenshot] }, () => {}, undefined, configured.runtime);
	const textOnly = await createFauxConversationRuntime({ images: false });
	await assert.rejects(
		runConversationSession({ ...input, images: [screenshot] }, () => {}, undefined, textOnly.runtime),
		{ message: "images" },
	);
	await assert.rejects(
		runConversationSession({ ...input, reasoningEffort: "high" }, () => {}, undefined, textOnly.runtime),
		{ message: "reasoning" },
	);
	assert.equal(textOnly.faux.state.callCount, 0);
	const renameInput = {
		...input,
		renameScope: {
			datasetVersionId: "v1",
			columns: [
				{ index: 0, name: "group" },
				{ index: 1, name: "value" },
			],
		},
	};
	const renameEvents: ConversationDriverEvent[] = [];
	let afterTool: Context | undefined;
	faux.setResponses([
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			assert.deepEqual(
				context.tools?.map((tool) => tool.name),
				["propose_column_rename"],
			);
			const parameters = context.tools![0].parameters;
			assert.ok("additionalProperties" in parameters);
			assert.equal(parameters.additionalProperties, false);
			assert.ok(
				"properties" in parameters && typeof parameters.properties === "object" && parameters.properties !== null,
			);
			const properties = parameters.properties;
			assert.deepEqual(Object.keys(properties).sort(), ["column", "datasetVersionId", "name"]);
			assert.ok("column" in properties && typeof properties.column === "object" && properties.column !== null);
			assert.ok("type" in properties.column);
			assert.equal(properties.column.type, "integer");
			return fauxAssistantMessage(
				[
					{ type: "text", text: "I can propose that rename. " },
					fauxToolCall(
						"propose_column_rename",
						{ column: 0, name: "cohort", datasetVersionId: "v1" },
						{ id: "rename-proof" },
					),
				],
				{ stopReason: "toolUse" },
			);
		},
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			afterTool = snapshotConversationContext(context);
			const acknowledgement = context.messages.at(-1);
			assert.equal(acknowledgement?.role, "toolResult");
			if (acknowledgement?.role !== "toolResult") throw new Error("Missing tool acknowledgement");
			assert.equal(acknowledgement.toolName, "propose_column_rename");
			assert.equal(acknowledgement.isError, false);
			assert.deepEqual(acknowledgement.content, [
				{
					type: "text",
					text: JSON.stringify({ status: "awaiting_review", toolCallId: "rename-proof", applied: false }),
				},
			]);
			return fauxAssistantMessage("Awaiting local review. No dataset change has been applied.");
		},
	]);
	const renameResult = await runConversationSession(
		renameInput,
		(event) => renameEvents.push(event),
		undefined,
		runtime,
	);
	assert.ok(afterTool);
	assert.equal(
		renameResult.text,
		"I can propose that rename. Awaiting local review. No dataset change has been applied.",
	);
	assert.equal(
		renameEvents
			.filter((event) => event.type === "text")
			.map((event) => event.delta)
			.join(""),
		renameResult.text,
	);
	assert.deepEqual(
		renameEvents.filter((event) => event.type === "rename_proposal"),
		[{ type: "rename_proposal", toolCallId: "rename-proof", datasetVersionId: "v1", column: 0, name: "cohort" }],
	);
	assert.deepEqual(Object.keys(renameResult).sort(), ["modelState", "sessionFile", "text", "usage"]);
	const renamedSession = (await readFile(renameResult.sessionFile, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const assistantMessages = renamedSession
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
		.map((entry) => entry.message);
	assert.equal(assistantMessages.length, 2);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		assert.equal(
			renameResult.usage[key],
			assistantMessages.reduce((sum, message) => sum + message.usage[key], 0),
		);
	}
	const renameResumed = await createFauxConversationRuntime();
	renameResumed.faux.setResponses([
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			assert.deepEqual(
				context.tools?.map((tool) => tool.name),
				["propose_column_rename"],
			);
			assert.deepEqual(
				context.messages.map((message) => message.role),
				["user", "assistant", "toolResult", "assistant", "user"],
			);
			return fauxAssistantMessage("Still awaiting your local review.");
		},
	]);
	const renameFollowup = await runConversationSession(
		{ ...renameInput, sessionFile: renameResult.sessionFile, user: "What happened?" },
		() => {},
		undefined,
		renameResumed.runtime,
	);
	assert.notEqual(renameFollowup.sessionFile, renameResult.sessionFile);
	assert.equal(renameFollowup.text, "Still awaiting your local review.");

	const chartScope = fauxConversationChartScope();
	const chartArgs = fauxConversationChart(chartScope);
	const chartInput = { ...input, chartScope };
	const mixedInput = { ...renameInput, chartScope };
	const chartEvents: ConversationDriverEvent[] = [];
	let chartAcknowledgement: Context | undefined;
	faux.setResponses([
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			assert.deepEqual(
				context.tools?.map((tool) => tool.name),
				["propose_chart"],
			);
			const parameters = context.tools![0].parameters;
			assert.ok("additionalProperties" in parameters && parameters.additionalProperties === false);
			assert.ok(
				"properties" in parameters && typeof parameters.properties === "object" && parameters.properties !== null,
			);
			assert.deepEqual(Object.keys(parameters.properties).sort(), [
				"affectedColumns",
				"confidence",
				"evidenceRefs",
				"explanation",
				"spec",
				"title",
			]);
			return fauxAssistantMessage(
				[
					{ type: "text", text: "A distribution may help. " },
					fauxToolCall("propose_chart", chartArgs, { id: "chart-proof" }),
				],
				{ stopReason: "toolUse" },
			);
		},
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			chartAcknowledgement = snapshotConversationContext(context);
			const ack = context.messages.at(-1);
			assert.equal(ack?.role, "toolResult");
			if (ack?.role !== "toolResult") throw new Error("Missing chart acknowledgement");
			assert.equal(ack.toolName, "propose_chart");
			assert.equal(ack.isError, false);
			assert.deepEqual(ack.content, [
				{
					type: "text",
					text: JSON.stringify({ status: "awaiting_review", toolCallId: "chart-proof", applied: false }),
				},
			]);
			assert.ok(!JSON.stringify(ack).includes("preview"));
			assert.ok(!JSON.stringify(ack).includes("marks"));
			return fauxAssistantMessage("Preview locally, then save or reject. Nothing has been created.");
		},
	]);
	const chartResult = await runConversationSession(chartInput, (event) => chartEvents.push(event), undefined, runtime);
	assert.ok(chartAcknowledgement);
	assert.deepEqual(
		chartEvents.filter((event) => event.type === "chart_proposal"),
		[{ type: "chart_proposal", toolCallId: "chart-proof", ...chartArgs }],
	);
	assert.equal(
		chartResult.text,
		"A distribution may help. Preview locally, then save or reject. Nothing has been created.",
	);
	const chartPersisted = await readFile(chartResult.sessionFile, "utf8");
	const chartMessages = chartPersisted
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
		.map((entry) => entry.message);
	assert.equal(chartMessages.length, 2);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		assert.equal(
			chartResult.usage[key],
			chartMessages.reduce((sum, message) => sum + message.usage[key], 0),
		);
	const chartResume = await createFauxConversationRuntime();
	chartResume.faux.setResponses([
		(rawContext) => {
			const context = snapshotConversationContext(rawContext);
			assert.deepEqual(
				context.tools?.map((tool) => tool.name),
				["propose_chart"],
			);
			assert.deepEqual(
				context.messages.map((message) => message.role),
				["user", "assistant", "toolResult", "assistant", "user"],
			);
			const results = context.messages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 1, "Local preview/save results are never added to provider history");
			assert.deepEqual(results[0].content, [
				{
					type: "text",
					text: JSON.stringify({ status: "awaiting_review", toolCallId: "chart-proof", applied: false }),
				},
			]);
			return fauxAssistantMessage("The proposal still awaits your local decision.");
		},
	]);
	const chartFollowup = await runConversationSession(
		{ ...chartInput, sessionFile: chartResult.sessionFile, user: "Continue" },
		() => {},
		undefined,
		chartResume.runtime,
	);
	assert.notEqual(chartFollowup.sessionFile, chartResult.sessionFile);
	assert.equal(await readFile(chartResult.sessionFile, "utf8"), chartPersisted);

	for (const args of [
		{ ...chartArgs, title: "x".repeat(121) },
		{ ...chartArgs, explanation: "" },
		{ ...chartArgs, confidence: "0.8" },
		{ ...chartArgs, confidence: 1.1 },
		{ ...chartArgs, evidenceRefs: ["invented-evidence"] },
		{ ...chartArgs, evidenceRefs: ["column.1.numeric.min", "column.1.numeric.min"] },
		{ ...chartArgs, affectedColumns: [0], spec: { ...chartArgs.spec, type: "bar", x: 0 } },
		{ ...chartArgs, affectedColumns: [] },
		{ ...chartArgs, affectedColumns: [1, 2] },
		{ ...chartArgs, affectedColumns: [1, 1] },
		{ ...chartArgs, spec: { ...chartArgs.spec, datasetVersionId: "stale" } },
		{ ...chartArgs, spec: { ...chartArgs.spec, x: 2 } },
		{ ...chartArgs, spec: { ...chartArgs.spec, x: "1" } },
		{ ...chartArgs, spec: { ...chartArgs.spec, bins: 5.5 } },
		{ ...chartArgs, spec: { ...chartArgs.spec, filters: [{ column: 2, op: "eq", value: "secret" }] } },
		{ ...chartArgs, spec: { ...chartArgs.spec, type: "correlation", x: null, aggregation: "none" } },
		{ ...chartArgs, spec: { ...chartArgs.spec, type: "model-result", x: null, aggregation: "none" } },
		{ ...chartArgs, spec: { ...chartArgs.spec, y2: 0 } },
		{ ...chartArgs, basis: "evidence-linked" },
		{ ...chartArgs, evidence: [{ id: "invented" }] },
		{ ...chartArgs, preview: { marks: [] } },
		{ ...chartArgs, state: "saved" },
		{ ...chartArgs, generatedCode: "print('must not execute')" },
		{ ...chartArgs, toolCallId: "spoofed" },
	]) {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("propose_chart", args), { stopReason: "toolUse" })]);
		const rejected: ConversationDriverEvent[] = [];
		await assert.rejects(
			runConversationSession(chartInput, (event) => rejected.push(event), undefined, runtime),
			{ message: "protocol" },
		);
		assert.deepEqual(
			rejected.filter((event) => event.type !== "model"),
			[],
		);
	}
	faux.setResponses([fauxAssistantMessage(fauxToolCall("propose_chart", chartArgs), { stopReason: "toolUse" })]);
	await assert.rejects(
		runConversationSession(input, () => {}, undefined, runtime),
		{ message: "protocol" },
	);
	const invalidChartScopeCalls = faux.state.callCount;
	for (const chartScope of [undefined, null, [], false]) {
		await assert.rejects(
			runConversationSession({ ...input, chartScope }, () => {}, undefined, runtime),
			{ message: "request" },
		);
	}
	assert.equal(faux.state.callCount, invalidChartScopeCalls);
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"propose_column_rename",
					{ column: 0, name: "cohort", datasetVersionId: "v1" },
					{ id: "valid-before-invalid" },
				),
				fauxToolCall("propose_chart", { ...chartArgs, evidenceRefs: ["invented"] }, { id: "invalid-after-valid" }),
			],
			{ stopReason: "toolUse" },
		),
	]);
	const malformedMixed: ConversationDriverEvent[] = [];
	await assert.rejects(
		runConversationSession(mixedInput, (event) => malformedMixed.push(event), undefined, runtime),
		{ message: "protocol" },
	);
	assert.deepEqual(
		malformedMixed.filter((event) => event.type !== "model"),
		[],
		"No tools execute when another call in the same message is malformed",
	);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("propose_chart", { ...chartArgs, evidenceRefs: [], confidence: 0.99 }, { id: "hypothesis" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("An exploratory hypothesis awaits review."),
	]);
	const hypothesis: ConversationDriverEvent[] = [];
	await runConversationSession(chartInput, (event) => hypothesis.push(event), undefined, runtime);
	assert.deepEqual(
		hypothesis.filter((event) => event.type === "chart_proposal"),
		[{ type: "chart_proposal", toolCallId: "hypothesis", ...chartArgs, evidenceRefs: [], confidence: 0.5 }],
	);
	for (const count of [8, 9]) {
		faux.setResponses([
			fauxAssistantMessage(
				Array.from({ length: count }, (_, index) =>
					index % 2
						? fauxToolCall("propose_chart", chartArgs, { id: `mixed-${index}` })
						: fauxToolCall(
								"propose_column_rename",
								{ column: 0, name: "cohort", datasetVersionId: "v1" },
								{ id: `mixed-${index}` },
							),
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Mixed proposals await local review."),
		]);
		const mixedEvents: ConversationDriverEvent[] = [];
		const pending = runConversationSession(mixedInput, (event) => mixedEvents.push(event), undefined, runtime);
		if (count === 9) {
			await assert.rejects(pending, { message: "output" });
			assert.deepEqual(
				mixedEvents.filter((event) => event.type !== "model"),
				[],
			);
		} else {
			await pending;
			assert.equal(
				mixedEvents.filter((event) => event.type === "rename_proposal" || event.type === "chart_proposal").length,
				8,
			);
		}
	}
	// Shared identity and count limits also span separate assistant tool messages.
	for (const duplicateId of [true, false]) {
		faux.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 8 }, (_, index) =>
					fauxToolCall(
						"propose_column_rename",
						{ column: 0, name: "cohort", datasetVersionId: "v1" },
						{ id: `prior-${index}` },
					),
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("propose_chart", chartArgs, { id: duplicateId ? "prior-0" : "ninth" }), {
				stopReason: "toolUse",
			}),
		]);
		await assert.rejects(
			runConversationSession(mixedInput, () => {}, undefined, runtime),
			{ message: duplicateId ? "protocol" : "output" },
		);
	}
	const largeChart = {
		...chartArgs,
		explanation: "雪".repeat(4000),
		spec: {
			...chartArgs.spec,
			filters: Array.from({ length: 8 }, () => ({ column: 1, op: "eq", value: "雪".repeat(512) })),
		},
	};
	faux.setResponses([
		fauxAssistantMessage(
			Array.from({ length: 8 }, (_, index) =>
				index === 0
					? fauxToolCall(
							"propose_column_rename",
							{ column: 0, name: "cohort", datasetVersionId: "v1" },
							{ id: `bytes-${index}` },
						)
					: fauxToolCall("propose_chart", largeChart, { id: `bytes-${index}` }),
			),
			{ stopReason: "toolUse" },
		),
	]);
	await assert.rejects(
		runConversationSession(mixedInput, () => {}, undefined, runtime),
		{ message: "output" },
	);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("propose_chart", chartArgs, { id: "text-budget" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("x".repeat(ASSISTANT_OUTPUT_BYTES)),
	]);
	await assert.rejects(
		runConversationSession(chartInput, () => {}, undefined, runtime),
		{ message: "output" },
	);

	// SDK failure, cancellation, and an uncommitted success all leave the published snapshot immutable.
	for (const kind of ["rename", "chart"] as const)
		for (const outcome of ["failure", "cancel", "uncommitted"] as const) {
			const isolatedRuntime = await createFauxConversationRuntime();
			const cancel = new AbortController();
			isolatedRuntime.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						kind === "chart" ? "propose_chart" : "propose_column_rename",
						kind === "chart" ? chartArgs : { column: 0, name: "cohort", datasetVersionId: "v1" },
						{ id: `unpublished-${outcome}` },
					),
					{ stopReason: "toolUse" },
				),
				(rawContext) => {
					const context = snapshotConversationContext(rawContext);
					assert.equal(context.messages.at(-1)?.role, "toolResult");
					if (outcome === "cancel") cancel.abort();
					return outcome === "failure"
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "failure after proposal" })
						: fauxAssistantMessage("This proposal is awaiting local review.");
				},
			]);
			let capturedProposals = 0;
			const pending = runConversationSession(
				{
					...(kind === "chart" ? chartInput : renameInput),
					sessionFile: result.sessionFile,
					user: `Unpublished ${outcome} ${kind}`,
				},
				(event) => {
					if (event.type === "rename_proposal" || event.type === "chart_proposal") capturedProposals++;
				},
				cancel.signal,
				isolatedRuntime.runtime,
			);
			if (outcome === "uncommitted") assert.notEqual((await pending).sessionFile, result.sessionFile);
			else await assert.rejects(pending, { message: outcome === "cancel" ? "cancelled" : "provider" });
			assert.equal(
				capturedProposals,
				1,
				"Proposal was acknowledged before the turn failed or publication was declined",
			);
			assert.equal(await readFile(result.sessionFile, "utf8"), persisted);
			const cleanRuntime = await createFauxConversationRuntime();
			let cleanContext: Context | undefined;
			cleanRuntime.faux.setResponses([
				(rawContext) => {
					const context = snapshotConversationContext(rawContext);
					cleanContext = snapshotConversationContext(context);
					return fauxAssistantMessage("Only the committed conversation is available.");
				},
			]);
			await runConversationSession(
				{
					...(kind === "chart" ? chartInput : renameInput),
					sessionFile: result.sessionFile,
					user: "Continue the committed conversation.",
				},
				() => {},
				undefined,
				cleanRuntime.runtime,
			);
			assert.ok(cleanContext);
			assert.deepEqual(
				cleanContext.messages.map((message) => message.role),
				["user", "assistant", "user"],
			);
			assert.ok(!JSON.stringify(cleanContext.messages).includes(`unpublished-${outcome}`));
			assert.ok(!JSON.stringify(cleanContext.messages).includes("awaiting_review"));
		}

	for (const [name, args] of [
		["bash", { command: "echo must-not-run" }],
		["propose_column_rename", { column: 0, name: "cohort", datasetVersionId: "wrong-version" }],
		["propose_column_rename", { column: 2, name: "cohort", datasetVersionId: "v1" }],
		["propose_column_rename", { column: 0, name: "value", datasetVersionId: "v1" }],
		["propose_column_rename", { column: 0.5, name: "cohort", datasetVersionId: "v1" }],
		["propose_column_rename", { column: "0", name: "cohort", datasetVersionId: "v1" }],
		["propose_column_rename", { column: 0, name: " ", datasetVersionId: "v1" }],
		["propose_column_rename", { column: 0, name: "cohort", datasetVersionId: "v1", sql: "SELECT secret" }],
	] as const) {
		faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })]);
		const rejectedEvents: ConversationDriverEvent[] = [];
		await assert.rejects(
			runConversationSession(renameInput, (event) => rejectedEvents.push(event), undefined, runtime),
			{ message: "protocol" },
		);
		assert.deepEqual(
			rejectedEvents.filter((event) => event.type !== "model"),
			[],
		);
	}
	faux.setResponses([
		fauxAssistantMessage(
			Array.from({ length: 9 }, (_, index) =>
				fauxToolCall(
					"propose_column_rename",
					{ column: 0, name: "cohort", datasetVersionId: "v1" },
					{ id: `limit-${index}` },
				),
			),
			{ stopReason: "toolUse" },
		),
	]);
	await assert.rejects(
		runConversationSession(renameInput, () => {}, undefined, runtime),
		{ message: "output" },
	);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("propose_column_rename", { column: 0, name: "cohort", datasetVersionId: "v1" }),
			{ stopReason: "toolUse" },
		),
	]);
	await assert.rejects(
		runConversationSession(input, () => {}, undefined, runtime),
		{ message: "protocol" },
	);
	faux.setResponses([
		fauxAssistantMessage(
			Array.from({ length: 8 }, (_, index) =>
				fauxToolCall(
					"propose_column_rename",
					{ column: 0, name: `cohort-${index}`, datasetVersionId: "v1" },
					{ id: `allowed-${index}` },
				),
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Eight alternatives await local review; none has been applied."),
	]);
	let allowedProposals = 0;
	await runConversationSession(
		renameInput,
		(event) => {
			if (event.type === "rename_proposal") allowedProposals++;
		},
		undefined,
		runtime,
	);
	assert.equal(allowedProposals, 8);
	const duplicate = fauxToolCall(
		"propose_column_rename",
		{ column: 0, name: "cohort", datasetVersionId: "v1" },
		{ id: "duplicate" },
	);
	faux.setResponses([fauxAssistantMessage([duplicate, duplicate], { stopReason: "toolUse" })]);
	await assert.rejects(
		runConversationSession(renameInput, () => {}, undefined, runtime),
		{ message: "protocol" },
	);
	const invalidScopeCalls = faux.state.callCount;
	await assert.rejects(
		runConversationSession(
			{
				...renameInput,
				renameScope: {
					datasetVersionId: "v1",
					columns: [
						{ index: 0, name: "group" },
						{ index: 0, name: "value" },
					],
				},
			},
			() => {},
			undefined,
			runtime,
		),
		{ message: "request" },
	);
	assert.equal(faux.state.callCount, invalidScopeCalls, "Invalid frozen scope cannot reach the provider");
	const before = faux.state.callCount;
	await assert.rejects(
		runConversationSession({ ...input, system: `${input.system}hidden` }, () => {}, undefined, runtime),
		{ message: "context" },
	);
	await assert.rejects(
		runConversationSession(input, () => {}, AbortSignal.abort(), runtime),
		{ message: "cancelled" },
	);
	assert.equal(faux.state.callCount, before, "Rejected context and pre-cancel cannot reach provider");
	for (const stopReason of ["error", "length"] as const) {
		const calls = faux.state.callCount;
		faux.setResponses([fauxAssistantMessage("partial", { stopReason, errorMessage: "secret-provider-error" })]);
		await assert.rejects(
			runConversationSession(input, () => {}, undefined, runtime),
			{ message: stopReason === "length" ? "output" : "provider" },
		);
		assert.equal(faux.state.callCount, calls + 1, "Provider failures must never retry");
	}
	faux.setResponses([fauxAssistantMessage("x".repeat(ASSISTANT_OUTPUT_BYTES + 1))]);
	let bytes = 0;
	await assert.rejects(
		runConversationSession(
			input,
			(event) => {
				if (event.type === "text") bytes += Buffer.byteLength(event.delta);
			},
			undefined,
			runtime,
		),
		{ message: "output" },
	);
	assert.ok(bytes <= ASSISTANT_OUTPUT_BYTES);
	faux.setResponses([fauxAssistantMessage("cancel me ".repeat(100))]);
	const abort = new AbortController();
	let deltas = 0;
	await assert.rejects(
		runConversationSession(
			input,
			() => {
				deltas++;
				abort.abort();
			},
			abort.signal,
			runtime,
		),
		{ message: "cancelled" },
	);
	assert.equal(deltas, 1, "No text follows cancellation");
	faux.setResponses([fauxAssistantMessage("After cancellation")]);
	assert.equal((await runConversationSession(input, () => {}, undefined, runtime)).text, "After cancellation");

	// Selection operates on a retained real SDK session and setup-only checkpoints restore.
	const { driver, providers } = await registered(configured.runtime);
	const scoped = { ...input, conversationId: "selection-proof", reasoningEffort: "high" as const };
	const originalDefault = providers.settings.getDefaultModel();
	const selection = await driver.selectModel(scoped, {
		provider: "openai",
		modelId: "fixture-second",
		thinkingLevel: "high",
		persist: false,
	});
	assert.equal(selection.modelState.model?.id, "fixture-second");
	assert.equal(selection.modelState.thinkingLevel, "high");
	assert.equal(providers.settings.getDefaultModel(), originalDefault, "Session selection must not change default");
	assert.ok(selection.sessionFile);
	await access(selection.sessionFile);
	const selectedBytes = await readFile(selection.sessionFile, "utf8");
	const restart = new PiConversationDriver(providers);
	try {
		const restored = await restart.modelState({ ...scoped, sessionFile: selection.sessionFile });
		assert.equal(restored.modelState.model?.id, "fixture-second");
		assert.equal(restored.modelState.thinkingLevel, "high");
	} finally {
		await restart.close();
	}
	assert.equal(await readFile(selection.sessionFile, "utf8"), selectedBytes);
	const beforePicker = configured.faux.state.callCount;
	await driver.selectDraftModel({
		provider: "openai",
		modelId: "fixture-second",
		thinkingLevel: "high",
		persist: true,
	});
	assert.equal((await driver.draftModelState()).model?.id, "fixture-second");
	assert.equal(providers.settings.getDefaultModel(), "fixture-second");
	assert.equal(providers.settings.getDefaultThinkingLevel(), "high");
	assert.equal(configured.faux.state.callCount, beforePicker, "Model selection never invokes a provider");
	const freshDraft = new PiConversationDriver(providers);
	try {
		assert.equal((await freshDraft.draftModelState()).model?.id, "fixture-second");
	} finally {
		await freshDraft.close();
	}
	configured.faux.setResponses([fauxAssistantMessage("Selected physical response")]);
	const physical = await driver.chat(
		{ ...scoped, sessionFile: selection.sessionFile },
		() => {},
		new AbortController().signal,
	);
	assert.equal(physical.modelState.model?.id, "fixture-second");
	assert.equal(physical.modelState.routedModel?.id, "fixture-second");
	const automatic = await driver.selectModel(
		{ ...scoped, sessionFile: physical.sessionFile },
		{ provider: "router", modelId: "auto", thinkingLevel: "high", persist: false },
	);
	const modelEvents: ConversationDriverEvent[] = [];
	configured.faux.setResponses([fauxAssistantMessage("Auto routed response")]);
	const routed = await driver.chat(
		{ ...scoped, sessionFile: automatic.sessionFile },
		(event) => modelEvents.push(event),
		new AbortController().signal,
	);
	assert.equal(routed.modelState.model?.provider, "router");
	assert.equal(routed.modelState.model?.id, "auto");
	assert.equal(routed.modelState.routedModel?.provider, "openai");
	assert.ok(["fixture", "fixture-second"].includes(routed.modelState.routedModel?.id ?? ""));
	assert.deepEqual(modelEvents.filter((event) => event.type === "model").at(-1), {
		type: "model",
		modelState: routed.modelState,
	});
	const oldSelectionBytes = await readFile(selection.sessionFile, "utf8");
	const unavailableCalls = configured.faux.state.callCount;
	const selectedModel = configured.runtime.getModel("openai", "fixture-second");
	assert.ok(selectedModel);
	configured.runtime.unregisterProvider("openai");
	const unavailable = new PiConversationDriver(providers);
	try {
		await assert.rejects(
			unavailable.chat({ ...scoped, sessionFile: selection.sessionFile }, () => {}, new AbortController().signal),
			{ message: ASSISTANT_WORKER_ERRORS.model },
		);
		assert.equal(
			configured.faux.state.callCount,
			unavailableCalls,
			"A removed saved model cannot silently route to an available provider",
		);
		const explicit = await unavailable.selectModel(
			{ ...scoped, sessionFile: selection.sessionFile },
			{ provider: "router", modelId: "auto", thinkingLevel: "high", persist: false },
		);
		assert.equal(explicit.modelState.model?.id, "auto", "An explicit replacement recovers a removed saved model");
	} finally {
		await unavailable.close();
	}
	assert.equal(await readFile(selection.sessionFile, "utf8"), oldSelectionBytes);
	// No raw provider errors or diagnostic bodies survive even in abandoned JSONL.
	for (const file of await readdir(input.sessionDir)) {
		if (file.endsWith(".jsonl"))
			assert.equal((await readFile(join(input.sessionDir, file), "utf8")).includes("secret-provider-error"), false);
	}
	assert.equal(networkCalls, 0);
	process.stdout.write("CONVERSATION_SDK_PROOF_OK\n");
} finally {
	for (const { driver, providers } of drivers.values()) {
		await driver.close();
		await providers.close();
	}
	await rm(root, { recursive: true, force: true });
}
