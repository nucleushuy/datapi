import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Window as TestWindow } from "happy-dom";
import {
	ASSISTANT_ATTACHMENT_FILE_BYTES,
	ASSISTANT_ATTACHMENT_MAX_FILES,
	ASSISTANT_ATTACHMENT_TOTAL_BYTES,
	type AssistantContext,
	type AssistantSelection,
} from "../../src/assistant-contracts.ts";
import {
	type ConversationUiContext,
	exportConversation,
	initializeConversation,
} from "../../src/browser/conversation.ts";
import type { AppKeybindings } from "../../src/browser/shell.ts";
import type { ChartRecord, ChartResult } from "../../src/chart-contracts.ts";
import { defaultChartSpec, generateChartPython } from "../../src/chart-spec.ts";
import type { Dataset } from "../../src/contracts.ts";
import type {
	ChartProposal,
	Conversation,
	ConversationChartPreview,
	ConversationChartSaved,
	ConversationEvent,
	RenameProposal,
} from "../../src/conversation-contracts.ts";
import type { ProviderCatalog, ProviderModel, SessionModelSelection, SessionModelState } from "../../src/provider-contracts.ts";
import type { TransformRecord } from "../../src/transform-contracts.ts";

const date = "2026-09-24T00:00:00.000Z";
const analystInstructions =
	"Act as Pi Analyst. Analyze the shared evidence, explain findings and uncertainty, and suggest useful next steps. Respect the active mode and required exact-operation approvals.";
const reviewerInstructions =
	"Act as Pi Reviewer. Critically review the requested analysis or proposal: check assumptions, data quality, methodology and risks. Distinguish evidence from inference and explain needed corrections. Respect the active mode and required exact-operation approvals.";
function dataset(id = "dataset-a", projectId = "project-a"): Dataset {
	return {
		id,
		projectId,
		name: id,
		originalFilename: "source.csv",
		format: "csv",
		createdAt: date,
		updatedAt: date,
		byteSize: 20,
		sha256: "a".repeat(64),
		rowCount: 2,
		columnCount: 1,
		ingestionStatus: "ready",
		schemaVersion: 2,
		storageLocation: "source",
		sourceVersionId: "version-a",
		currentVersionId: "version-a",
		versions: [],
		schema: [{ index: 0, name: "amount", sourceType: "VARCHAR", basicType: "number" }],
		columns: [],
		parsing: { format: "csv", encoding: "utf-8", delimiter: ",", header: true, emptyValues: "empty-string" },
		profileVersion: 1,
		profiledAt: date,
	};
}
function uiContext(value = dataset()): ConversationUiContext {
	return {
		projectId: value.projectId,
		dataset: value,
		profile: null,
		selectedColumns: [0],
		filters: [{ column: 0, op: "gt", value: "4" }],
		revision: 1,
	};
}
function frozen(value = dataset()): AssistantContext {
	return {
		version: 1,
		project: { id: value.projectId, name: "Project", description: "" },
		dataset: {
			id: value.id,
			name: value.name,
			versionId: value.currentVersionId,
			artifactHash: value.sha256,
			rowCount: value.rowCount,
			columnCount: value.columnCount,
		},
		schema: value.schema,
		selectedColumns: [0],
		filters: [{ column: 0, op: "gt", value: "4" }],
		evidence: [{ id: "rows", metric: "rowCount", value: 2, columns: [], basis: "full", rows: 2, approximate: false }],
		artifacts: [],
		limitations: [],
		rowsIncluded: false,
	};
}
function availableModel(overrides: Partial<ProviderModel> = {}): ProviderModel {
	return {
		provider: "test", id: "model", name: "Model", contextWindow: 32000, maxTokens: 4096,
		input: ["text", "image"], reasoning: true, thinkingLevels: ["off", "low", "high"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, billing: "api", virtual: false,
		...overrides,
	};
}
function selectedModel(model = availableModel()): SessionModelState {
	return { model, thinkingLevel: "off", routedModel: null };
}
function saved(id = "chat-a", value = dataset()): Conversation {
	return {
		id,
		projectId: value.projectId,
		datasetId: value.id,
		createdAt: date,
		title: "Saved chat",
		archivedAt: null,
		updatedAt: date,
		state: "ready",
		sessionFile: null,
		modelState: selectedModel(),
		scope: {
			version: 1,
			projectId: value.projectId,
			datasetId: value.id,
			datasetVersionId: value.currentVersionId,
			provider: "test",
			modelId: "model",
			context: frozen(value),
			contextHash: "b".repeat(64),
			grantedAt: date,
		},
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		error: null,
	};
}
function renameProposal(overrides: Partial<RenameProposal> = {}): RenameProposal {
	return {
		id: "rename-a",
		projectId: "project-a",
		datasetId: "dataset-a",
		conversationId: "chat-a",
		toolCallId: "call-a",
		inputVersionId: "version-a",
		column: 0,
		oldName: "amount",
		name: "total",
		state: "proposed",
		createdAt: date,
		updatedAt: date,
		preview: null,
		outputVersionId: null,
		error: null,
		audit: [{ at: date, action: "proposed", actor: "pi" }],
		...overrides,
	};
}
function previewedProposal(overrides: Partial<RenameProposal> = {}): RenameProposal {
	return renameProposal({
		state: "previewed",
		preview: {
			id: "preview-a",
			expiresAt: "2099-01-01T00:00:00.000Z",
			sql: 'SELECT "amount" AS "total" FROM input',
			inputRows: 2,
			outputRows: 2,
			affectedRows: 0,
		},
		audit: [
			{ at: date, action: "proposed", actor: "pi" },
			{ at: date, action: "preview_requested", actor: "local-user" },
			{ at: date, action: "previewed", actor: "system" },
		],
		...overrides,
	});
}
function chart(value = dataset(), name = "Saved chart"): ChartRecord {
	return {
		id: "chart-a",
		projectId: value.projectId,
		datasetId: value.id,
		name,
		createdAt: date,
		updatedAt: date,
		spec: defaultChartSpec(value.currentVersionId),
	};
}
function chartProposal(overrides: Partial<ChartProposal> = {}): ChartProposal {
	return {
		id: "chart-proposal-a",
		projectId: "project-a",
		datasetId: "dataset-a",
		conversationId: "chat-a",
		toolCallId: "chart-call-a",
		inputVersionId: "version-a",
		title: "Amount distribution",
		explanation: "Inspect the distribution before drawing conclusions.",
		confidence: 0.8,
		evidenceRefs: ["rows"],
		affectedColumns: [0],
		spec: { ...defaultChartSpec("version-a"), x: 0 },
		basis: "evidence-linked",
		state: "proposed",
		createdAt: date,
		updatedAt: date,
		preview: null,
		chartId: null,
		error: null,
		audit: [{ at: date, actor: "pi", action: "proposed" }],
		...overrides,
	};
}
function chartPreview(overrides: Partial<ChartProposal> = {}): ConversationChartPreview {
	const proposal = chartProposal({
		state: "previewed",
		preview: {
			id: "chart-preview-a",
			expiresAt: "2099-01-01T00:00:00.000Z",
			datasetVersionHash: "a".repeat(64),
			specHash: "c".repeat(64),
			populationRows: 20,
			sampleSize: 2,
			sampled: true,
		},
		audit: [
			{ at: date, actor: "pi", action: "proposed" },
			{ at: date, actor: "local-user", action: "preview_requested" },
			{ at: date, actor: "system", action: "previewed" },
		],
		...overrides,
	});
	const result: ChartResult = {
		spec: proposal.spec,
		datasetVersionHash: "a".repeat(64),
		generatedAt: date,
		populationRows: 20,
		sampleSize: 2,
		stride: 10,
		byteLimited: false,
		sampled: true,
		filteredRows: 2,
		excludedRows: 1,
		omittedMarks: 0,
		marks: [
			{
				x: 5,
				y: 2,
				value: 2,
				color: null,
				size: null,
				facet: null,
				low: 0,
				high: 10,
				q1: null,
				median: null,
				q3: null,
				rowIds: [0, 10],
			},
		],
		table: { columns: dataset().schema, rows: [{ rowId: 0, values: ["PRIVATE_PREVIEW_CELL"] }] },
		warnings: ["Only the bounded sample is shown."],
		labels: {
			x: "amount",
			y: "Observed count",
			color: "None",
			size: "None",
			facet: "None",
			aggregation: "count",
			filters: "amount gt 4",
			missing: "Null and invalid values excluded",
		},
	};
	return { proposal, chart: result };
}
function record(id = "result-a"): TransformRecord {
	return {
		id,
		projectId: "project-a",
		datasetId: "dataset-a",
		actor: "local-user",
		createdAt: date,
		completedAt: date,
		inputVersionId: "version-a",
		outputVersionId: null,
		spec: {
			version: 1,
			datasetVersionId: "version-a",
			operation: { kind: "rename", column: 0, name: "SECRET_COMPARISON" },
		},
		state: "failed",
		result: null,
		error: "SECRET_ERROR_PROSE",
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function settle() {
	await setImmediate();
}

type Respond = (path: string, init: RequestInit) => unknown | Promise<unknown>;
function setup(
	t: TestContext,
	config: {
		sessions?: Conversation[];
		models?: ProviderModel[];
		draftModelState?: SessionModelState;
		respond?: Respond;
		records?: TransformRecord[];
		proposals?: RenameProposal[];
		chartProposals?: ChartProposal[];
		onChartSaved?(value: ChartRecord): Promise<void> | void;
		onChanged?(value: Dataset): Promise<void> | void;
		keybindings?: Partial<AppKeybindings>;
		onDatasetSelected?(id: string): Promise<void> | void;
	} = {},
) {
	const browser = new TestWindow({ url: "http://localhost:4310", width: 360, height: 900 });
	const document = browser.document as unknown as Document;
	const container = document.createElement("div");
	document.body.append(container);
	const requests: { path: string; init: RequestInit }[] = [];
	const changes: Dataset[] = [];
	const savedCharts: ChartRecord[] = [];
	const streams: {
		path: string;
		message: string;
		onEvent: (event: ConversationEvent) => void;
		completion: ReturnType<typeof deferred<Conversation>>;
	}[] = [];
	let serverConversation = saved();
	const available = config.models ?? [availableModel()];
	let draftState = config.draftModelState ?? selectedModel(available[0]);
	const sessionModels = new Map((config.sessions ?? []).map((item) => [item.id, item.modelState]));
	const controller = initializeConversation(container, {
		keybindings: config.keybindings,
		onDatasetSelected: config.onDatasetSelected,
		async api<T>(path: string, init: RequestInit = {}): Promise<T> {
			requests.push({ path, init });
			const response = config.respond?.(path, init);
			if (response !== undefined) return (await response) as T;
			if (path === "/api/chat/models") return { models: available, guidance: "" } as T;
			if (path === "/api/providers") {
				const catalog: ProviderCatalog = {
					models: available,
					guidance: "Configuration checked by Pi; authentication is not independently verified.",
					providers: [...new Set(available.map((item) => item.provider))].map((id) => ({
						id, name: id, auth: { oauth: null, apiKey: { label: `Enter ${id} key`, interactive: true } },
						state: "connected", configured: true, authType: "api_key", storedAuthType: "api_key",
						source: "stored", modelCount: available.filter((item) => item.provider === id).length, message: "Configured",
					})),
				};
				return catalog as T;
			}
			if (path.endsWith("/model")) {
				const id = path.match(/\/conversations\/([^/]+)\/model$/)?.[1];
				let state = id ? sessionModels.get(id) ?? serverConversation.modelState : draftState;
				if (init.method === "PUT") {
					const selection = JSON.parse(String(init.body)) as SessionModelSelection;
					const model = available.find((item) => item.provider === selection.provider && item.id === selection.modelId);
					assert.ok(model, "selected model must be available");
					state = { model, thinkingLevel: selection.thinkingLevel, routedModel: null };
					if (id) sessionModels.set(id, state);
					else draftState = state;
				}
				return structuredClone(state) as T;
			}
			if (path.endsWith("/charts")) return [chart()] as T;
			if (path.endsWith("/transforms/history"))
				return {
					currentVersionId: "version-a",
					canUndo: false,
					canRedo: false,
					records: config.records ?? [record()],
				} as T;
			if (path.endsWith("/conversations") && !init.method) return (config.sessions ?? []) as T;
			if (path.endsWith("/proposals") && !init.method) return (config.proposals ?? []) as T;
			if (path.endsWith("/chart-proposals") && !init.method) return (config.chartProposals ?? []) as T;
			if (path.endsWith("/conversations") && init.method === "POST") {
				const selection = JSON.parse(String(init.body)) as AssistantSelection;
				serverConversation = saved();
				serverConversation.modelState = structuredClone(draftState);
				sessionModels.set(serverConversation.id, serverConversation.modelState);
				serverConversation.title = selection.request.trim().slice(0, 120);
				const settings = JSON.parse(String(init.body));
				serverConversation.mode = settings.mode;
				serverConversation.reasoningEffort = settings.reasoningEffort;
				serverConversation.scope.provider = selection.provider!;
				serverConversation.scope.modelId = selection.modelId!;
				serverConversation.scope.screenshots = settings.screenshots?.map(
					(image: { name: string; mediaType: "image/png"; data: string }) => ({
						...image,
						byteLength: Buffer.from(image.data, "base64").length,
						sha256: createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"),
					}),
				);
				serverConversation.scope.context.attachedFiles = selection.attachments?.map((item) => ({
					...item,
					byteLength: Buffer.byteLength(item.content),
					sha256: createHash("sha256").update(item.content).digest("hex"),
				}));
				serverConversation.scope.context.executionResults = selection.executionIds?.map((id) => ({
					id,
					projectId: "project-a",
					datasetId: "dataset-a",
					state: "failed",
					kind: "rename",
					inputVersionId: "version-a",
					outputVersionId: null,
					createdAt: date,
					completedAt: date,
					impact: null,
				}));
				return structuredClone(serverConversation) as T;
			}
			if (init.method === "DELETE") return structuredClone(serverConversation) as T;
			throw new Error(`Unexpected API request: ${path}`);
		},
		stream(path, message, onEvent) {
			const completion = deferred<Conversation>();
			streams.push({ path, message, onEvent, completion });
			return completion.promise;
		},
		message(error) {
			return error instanceof Error ? error.message : String(error);
		},
		async onChanged(value) {
			changes.push(value);
			await config.onChanged?.(value);
		},
		async onChartSaved(value) {
			savedCharts.push(value);
			await config.onChartSaved?.(value);
		},
	});
	t.after(async () => {
		controller.dispose();
		await browser.happyDOM.close();
	});
	function element<T extends HTMLElement = HTMLElement>(id: string): T {
		const value = document.getElementById(`conversation-${id}`);
		assert.ok(value, id);
		return value as T;
	}
	function change(id: string, value: string) {
		element<HTMLInputElement>(id).value = value;
		element(id).dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
	}
	function choose(files: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }[]) {
		Object.defineProperty(element("files"), "files", { configurable: true, value: files });
		element("files").dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
	}
	function textFile(name: string, content: string | Uint8Array) {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		return {
			name,
			size: bytes.byteLength,
			async arrayBuffer() {
				return Uint8Array.from(bytes).buffer;
			},
		};
	}
	function submit() {
		container
			.querySelector(".assistant-form")!
			.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
	}
	async function chooseModel(name: string): Promise<void> {
		element<HTMLButtonElement>("model").click();
		await settle();
		const choice = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
			.find((item) => item.getAttribute("aria-label")?.startsWith(`${name} — `));
		assert.ok(choice, `available model ${name}`);
		choice.click();
	}
	function applyModel(): void {
		const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Use model");
		assert.ok(apply, "model selection submit");
		apply.click();
	}
	function closeProviders(): void {
		const close = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((item) => item.textContent === "Done" || item.textContent === "Close");
		assert.ok(close, "provider dialog close");
		close.click();
	}
	async function selectModel(name: string): Promise<void> {
		await chooseModel(name);
		applyModel();
		await settle();
		closeProviders();
	}
	function complete(text = "Answer", index = streams.length - 1) {
		const value = structuredClone(serverConversation);
		value.title = "Updated chat title";
		value.messages = [
			{ id: "user", role: "user", text: streams[index]!.message, createdAt: date, state: "complete" },
			{ id: "answer", role: "assistant", text, createdAt: date, state: "complete" },
		];
		streams[index]!.completion.resolve(value);
		return value;
	}
	return {
		browser,
		document,
		container,
		controller,
		requests,
		streams,
		changes,
		savedCharts,
		element,
		change,
		choose,
		textFile,
		submit,
		complete,
		chooseModel,
		applyModel,
		closeProviders,
		selectModel,
	};
}

test("attachments stay local until consent and Send; exact input fields and result IDs are sent once", async (t) => {
	const ui = setup(t);
	ui.controller.update(uiContext());
	await settle();
	ui.change("message", "Explain this file");
	const content = '<img src=x onerror="alert(1)">\n<script>unsafe()</script>\nπ';
	ui.choose([ui.textFile("notes.md", content)]);
	await settle();
	assert.equal(ui.element("file-list").querySelector("pre")?.textContent, content);
	assert.equal(ui.container.querySelector("img, script"), null);
	assert.equal(ui.browser.localStorage.length, 0);
	assert.equal(ui.browser.sessionStorage.length, 0);
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, true);
	ui.submit();
	await settle();
	assert.equal(
		ui.requests.some(({ init }) => init.method === "POST"),
		false,
	);
	assert.equal(ui.streams.length, 0);
	ui.element("executions").querySelector<HTMLInputElement>("input")!.click();
	assert.doesNotMatch(ui.element("executions").textContent ?? "", /SECRET/);
	ui.element<HTMLInputElement>("file-consent").click();
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, false);
	assert.equal(
		ui.requests.some(({ init }) => init.method === "POST"),
		false,
	);
	ui.submit();
	ui.submit();
	await settle();
	const posts = ui.requests.filter(({ init }) => init.method === "POST");
	assert.equal(posts.length, 1);
	assert.deepEqual(JSON.parse(String(posts[0]!.init.body)), {
		datasetVersionId: "version-a",
		selectedColumns: [0],
		filters: [{ column: 0, op: "gt", value: "4" }],
		request: "Explain this file",
		provider: "test",
		modelId: "model",
		mode: "execute",
		reasoningEffort: "off",
		attachments: [{ name: "notes.md", mediaType: "text/plain", content }],
		executionIds: ["result-a"],
	});
	assert.equal(ui.streams[0]!.path, "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/messages");
	assert.equal(ui.streams[0]!.message, `${analystInstructions}\n\nExplain this file`);
	assert.match(
		ui.element("file-list").textContent ?? "",
		new RegExp(createHash("sha256").update(content).digest("hex")),
	);
	assert.match(ui.element("file-list").textContent ?? "", new RegExp(`${Buffer.byteLength(content)} bytes`));
	assert.equal(ui.element("file-list").querySelector("button"), null);
	assert.equal(ui.element<HTMLInputElement>("files").hidden, true);
	assert.equal(ui.element<HTMLButtonElement>("new").disabled, true);
	ui.complete();
	await settle();
	assert.match(ui.container.querySelector(".chat-session-list")!.textContent ?? "", /Updated chat title/);
	ui.change("message", "Follow up");
	ui.submit();
	await settle();
	assert.equal(ui.requests.filter(({ init }) => init.method === "POST").length, 1);
	assert.equal(ui.streams[1]!.message, `${analystInstructions}\n\nFollow up`);
	ui.complete("Second answer");
	await settle();
	ui.element<HTMLButtonElement>("new").click();
	ui.container.querySelector<HTMLButtonElement>(".chat-session-list button")!.click();
	assert.match(ui.container.querySelector(".assistant-history")!.textContent ?? "", /Second answer/);
	assert.match(ui.element("file-list").textContent ?? "", /SHA-256/);
});

test("no optional context is sent by default and incremental text stays safe and visible", async (t) => {
	const ui = setup(t);
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("provider").textContent ?? "", /test/);
	assert.equal(ui.element("model").textContent, "Model");
	assert.match(
		ui.element("context").textContent ?? "",
		/Dataset: dataset-a.*Version: version-a.*Columns: amount.*Filters: amount gt 4.*Chart: Saved chart/s,
	);
	ui.change("message", "Question");
	ui.submit();
	await settle();
	assert.deepEqual(JSON.parse(String(ui.requests.find(({ init }) => init.method === "POST")!.init.body)), {
		datasetVersionId: "version-a",
		selectedColumns: [0],
		filters: [{ column: 0, op: "gt", value: "4" }],
		request: "Question",
		provider: "test",
		modelId: "model",
		mode: "execute",
		reasoningEffort: "off",
	});
	const stream = ui.streams[0]!;
	stream.onEvent({ type: "text", conversationId: "wrong-chat", messageId: "x", delta: "WRONG" });
	stream.onEvent({ type: "text", conversationId: "chat-a", messageId: "x", delta: "First " });
	assert.match(ui.container.querySelector(".assistant-history")!.textContent ?? "", /First /);
	stream.onEvent({ type: "text", conversationId: "chat-a", messageId: "x", delta: "<b>second</b>" });
	assert.match(ui.container.querySelector(".assistant-history")!.textContent ?? "", /First <b>second<\/b>/);
	assert.equal(ui.container.querySelector(".assistant-history b"), null);
	assert.doesNotMatch(ui.container.textContent ?? "", /WRONG/);
	ui.complete("First <b>second</b>");
	await settle();
	assert.equal(ui.element<HTMLTextAreaElement>("message").disabled, false);
	assert.equal(ui.element<HTMLButtonElement>("stop").hidden, true);
});

test("removal and changing provider revoke file consent", async (t) => {
	const ui = setup(t, { models: [availableModel(), availableModel({ provider: "future-provider", id: "new-model", name: "Future model" })] });
	ui.controller.update(uiContext());
	await settle();
	ui.choose([ui.textFile("one.txt", "one"), ui.textFile("two.txt", "two")]);
	await settle();
	ui.element<HTMLInputElement>("file-consent").click();
	ui.element("file-list").querySelector<HTMLButtonElement>("button")!.click();
	assert.equal(ui.element<HTMLInputElement>("file-consent").checked, false);
	assert.doesNotMatch(ui.element("file-list").textContent ?? "", /one.txt/);
	ui.element<HTMLInputElement>("file-consent").click();
	await ui.selectModel("Future model");
	assert.equal(ui.element<HTMLInputElement>("file-consent").checked, false);
});

test("file validation rejects invalid UTF-8, controls, names, count and byte limits without POST", async (t) => {
	const cases: { name: string; files: { name: string; content: string | Uint8Array }[]; error: RegExp }[] = [
		{ name: "UTF-8", files: [{ name: "bad.txt", content: Uint8Array.of(0xc3, 0x28) }], error: /not valid UTF-8/ },
		{ name: "binary", files: [{ name: "bad.py", content: "x\0y" }], error: /binary or control/ },
		{ name: "C1", files: [{ name: "bad.sql", content: "x\u0085y" }], error: /binary or control/ },
		{ name: "path", files: [{ name: "../bad.txt", content: "x" }], error: /Unsupported attachment name/ },
		{ name: "extension", files: [{ name: "bad.exe", content: "x" }], error: /Unsupported attachment name/ },
		{ name: "reserved", files: [{ name: "CON.txt", content: "x" }], error: /Unsupported attachment name/ },
		{
			name: "file bytes",
			files: [{ name: "big.txt", content: "π".repeat(ASSISTANT_ATTACHMENT_FILE_BYTES / 2 + 1) }],
			error: /exceeds.*bytes/,
		},
		{
			name: "count",
			files: Array.from({ length: ASSISTANT_ATTACHMENT_MAX_FILES + 1 }, (_, index) => ({
				name: `${index}.txt`,
				content: "x",
			})),
			error: /at most 8/,
		},
		{
			name: "total bytes",
			files: Array.from(
				{ length: ASSISTANT_ATTACHMENT_TOTAL_BYTES / ASSISTANT_ATTACHMENT_FILE_BYTES + 1 },
				(_, index) => ({ name: `${index}.txt`, content: "a".repeat(ASSISTANT_ATTACHMENT_FILE_BYTES) }),
			),
			error: /bytes in total/,
		},
	];
	for (const item of cases)
		await t.test(item.name, async (t) => {
			const ui = setup(t);
			ui.controller.update(uiContext());
			await settle();
			ui.choose(item.files.map((file) => ui.textFile(file.name, file.content)));
			await settle();
			assert.match(ui.element("feedback").textContent ?? "", item.error);
			assert.equal(ui.element("file-list").children.length, 0);
			assert.equal(
				ui.requests.some(({ init }) => init.method === "POST"),
				false,
			);
		});
});

test("UTF-8 BOM and allowed whitespace survive local inspection and exact upload", async (t) => {
	const ui = setup(t);
	ui.controller.update(uiContext());
	await settle();
	const content = "\ufeff\tπ\r\n";
	ui.choose([ui.textFile("script.PY", content)]);
	await settle();
	assert.equal(ui.element("file-list").querySelector("pre")!.textContent, content);
	ui.element<HTMLInputElement>("file-consent").click();
	ui.change("message", "Read only");
	ui.submit();
	await settle();
	assert.equal(
		JSON.parse(String(ui.requests.find(({ init }) => init.method === "POST")!.init.body)).attachments[0].content,
		content,
	);
	ui.complete();
});

test("resumed and reloaded chats disclose frozen metadata and legacy absent optional fields stay empty", async (t) => {
	const previous = saved();
	previous.scope.context.dataset.name = "Frozen dataset";
	previous.scope.context.filters = [{ column: 0, op: "eq", value: "old filter" }];
	previous.scope.context.artifacts = [
		{ id: "old-chart", name: "Frozen chart", type: "bar", datasetVersionId: "old-version" },
	];
	const ui = setup(t, { sessions: [previous] });
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("context").textContent ?? "", /Frozen dataset.*1 frozen metrics.*old filter.*Frozen chart/s);
	assert.doesNotMatch(ui.element("context").textContent ?? "", /Saved chart/);
	assert.equal(ui.element("file-list").children.length, 0);
	assert.match(ui.element("executions").textContent ?? "", /No execution results shared/);
	assert.match(ui.element("provider").textContent ?? "", /test/);
	ui.controller.update({ ...uiContext(), selectedColumns: [], filters: [], revision: 2 });
	await settle();
	assert.match(ui.element("context").textContent ?? "", /old filter/);
	ui.controller.update(null);
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("context").textContent ?? "", /Frozen chart/);
	ui.element<HTMLButtonElement>("new").click();
	await settle();
	assert.match(ui.element("context").textContent ?? "", /Dataset: dataset-a.*Saved chart/s);
	assert.equal(ui.element<HTMLInputElement>("files").hidden, false);
});

test("stale session and metadata loads cannot overwrite another project or dataset", async (t) => {
	const chats = deferred<Conversation[]>();
	const charts = deferred<ChartRecord[]>();
	const history = deferred<unknown>();
	const other = dataset("dataset-b", "project-b");
	const ui = setup(t, {
		respond(path) {
			if (path.includes("project-a")) {
				if (path.endsWith("/conversations")) return chats.promise;
				if (path.endsWith("/charts")) return charts.promise;
				if (path.endsWith("/transforms/history")) return history.promise;
			}
			if (path.includes("project-b") && path.endsWith("/charts")) return [chart(other, "Other chart")];
			if (path.includes("project-b") && path.endsWith("/transforms/history")) return { records: [] };
		},
	});
	ui.controller.update(uiContext());
	ui.controller.update(uiContext(other));
	await settle();
	chats.resolve([saved()]);
	charts.resolve([chart(dataset(), "STALE_CHART")]);
	history.resolve({ records: [record("STALE_RESULT")] });
	await settle();
	assert.match(ui.element("context").textContent ?? "", /dataset-b.*Other chart/s);
	assert.doesNotMatch(ui.container.textContent ?? "", /STALE|Saved chat/);
	assert.equal(ui.element<HTMLInputElement>("files").hidden, false);
});

test("file reads and create responses are discarded after switching context", async (t) => {
	const bytes = deferred<ArrayBuffer>();
	const created = deferred<Conversation>();
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/conversations") && init.method === "POST") return created.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.choose([{ name: "late.txt", size: 4, arrayBuffer: () => bytes.promise }]);
	ui.controller.update(uiContext(dataset("dataset-b", "project-b")));
	bytes.resolve(new TextEncoder().encode("late").buffer);
	await settle();
	assert.equal(ui.element("file-list").children.length, 0);
	assert.equal(ui.element<HTMLInputElement>("file-consent").checked, false);
	ui.change("message", "Create");
	ui.submit();
	assert.equal(ui.element<HTMLButtonElement>("new").disabled, true);
	ui.controller.update(uiContext());
	created.resolve(saved("late-chat", dataset("dataset-b", "project-b")));
	await settle();
	assert.equal(ui.streams.length, 0);
	assert.doesNotMatch(ui.container.querySelector(".chat-session-list")!.textContent ?? "", /Saved chat/);
	assert.equal(ui.element<HTMLTextAreaElement>("message").value, "");
});

test("streaming locks session switching and late events cannot alter the next dataset", async (t) => {
	const ui = setup(t, {
		sessions: [saved("previous")],
		respond(path, init) {
			if (path.includes("project-b") && path.endsWith("/conversations") && !init.method) return [];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.element<HTMLButtonElement>("new").click();
	ui.change("message", "Question");
	ui.submit();
	await settle();
	assert.ok(
		[...ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-list button")].every(
			(button) => button.disabled,
		),
	);
	ui.container.querySelector<HTMLButtonElement>(".chat-session-list button")!.click();
	assert.equal(ui.element<HTMLButtonElement>("new").disabled, true);
	ui.controller.update(uiContext(dataset("dataset-b", "project-b")));
	await settle();
	ui.streams[0]!.onEvent({ type: "text", conversationId: "chat-a", messageId: "x", delta: "STALE_STREAM" });
	ui.complete("STALE_FINAL");
	await settle();
	assert.match(ui.element("context").textContent ?? "", /dataset-b/);
	assert.doesNotMatch(ui.container.textContent ?? "", /STALE/);
	assert.equal(ui.element<HTMLTextAreaElement>("message").disabled, false);
});

test("metadata, create, streaming and Stop failures remain visible and controls recover", async (t) => {
	const ui = setup(t, {
		respond(path, init) {
			if (path.endsWith("/charts")) return Promise.reject(new Error("Chart access denied"));
			if (path.endsWith("/transforms/history")) return Promise.reject(new Error("History unavailable"));
			if (init.method === "DELETE") return Promise.reject(new Error("Stop failed"));
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("context").textContent ?? "", /Chart access denied/);
	assert.match(ui.element("executions").textContent ?? "", /History unavailable/);
	ui.change("message", "Question");
	ui.submit();
	await settle();
	ui.element<HTMLButtonElement>("stop").click();
	await settle();
	assert.match(ui.element("feedback").textContent ?? "", /Stop failed/);
	ui.streams[0]!.completion.reject(new Error("Stream interrupted"));
	await settle();
	assert.match(ui.element("feedback").textContent ?? "", /Stream interrupted/);
	assert.equal(ui.element<HTMLTextAreaElement>("message").disabled, false);
	assert.match(ui.container.querySelector(".assistant-history")!.textContent ?? "", /Question/);
	const failure = setup(t, {
		respond(path, init) {
			if (path.endsWith("/conversations") && init.method === "POST")
				return Promise.reject(new Error("Create failed"));
		},
	});
	failure.controller.update(uiContext());
	await settle();
	failure.change("message", "Keep draft");
	failure.submit();
	await settle();
	assert.match(failure.element("feedback").textContent ?? "", /Create failed/);
	assert.equal(failure.element<HTMLTextAreaElement>("message").value, "Keep draft");
	assert.equal(failure.element<HTMLButtonElement>("send").disabled, false);
});

test("result references are explicit and limited to eight", async (t) => {
	const ui = setup(t, { records: Array.from({ length: 9 }, (_, index) => record(`result-${index}`)) });
	ui.controller.update(uiContext());
	await settle();
	const choices = [...ui.element("executions").querySelectorAll<HTMLInputElement>("input")];
	for (const choice of choices.slice(0, 8)) choice.click();
	assert.equal(choices[8]!.disabled, true);
	choices[0]!.click();
	assert.equal(choices[8]!.disabled, false);
	ui.change("message", "Selected results");
	ui.submit();
	await settle();
	const payload = JSON.parse(String(ui.requests.find(({ init }) => init.method === "POST")!.init.body));
	assert.deepEqual(
		payload.executionIds,
		Array.from({ length: 7 }, (_, index) => `result-${index + 1}`),
	);
	assert.equal("attachments" in payload, false);
	assert.equal("executionResults" in payload, false);
	ui.complete();
});

test("rename proposals require an exact local preview approval and refresh the dataset once", async (t) => {
	const proposed = renameProposal();
	const previewed = previewedProposal();
	const nextDataset = {
		...dataset(),
		currentVersionId: "version-b",
		schema: [{ ...dataset().schema[0]!, name: "total" }],
	};
	const applied = renameProposal({
		state: "applied",
		preview: previewed.preview,
		outputVersionId: "version-b",
		audit: [
			...previewed.audit,
			{ at: date, actor: "local-user", action: "approved" },
			{ at: date, actor: "system", action: "applied" },
		],
	});
	const applying = deferred<{ proposal: RenameProposal; dataset: Dataset }>();
	const ui = setup(t, {
		sessions: [saved()],
		proposals: [proposed],
		respond(path) {
			if (path.endsWith("/preview")) return previewed;
			if (path.endsWith("/apply")) return applying.promise;
		},
		onChanged(value) {
			ui.controller.update(uiContext(value));
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").disabled, true);
	assert.equal(ui.requests.filter(({ init }) => init.method === "POST").length, 0);
	ui.element<HTMLButtonElement>("proposal-rename-a-preview").click();
	await settle();
	const previewRequest = ui.requests.find(({ path }) => path.endsWith("/preview"))!;
	assert.equal(
		previewRequest.path,
		"/api/projects/project-a/datasets/dataset-a/conversations/chat-a/proposals/rename-a/preview",
	);
	assert.deepEqual(previewRequest.init, { method: "POST" });
	assert.match(ui.element("proposals").textContent ?? "", /Input rows: 2 · Output rows: 2 · Affected rows: 0/);
	assert.match(ui.element("proposals").textContent ?? "", /No preview data, SQL or cell rows are sent/);
	assert.equal(ui.element("proposals").querySelector("pre")!.textContent, previewed.preview!.sql);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, false);
	ui.element<HTMLButtonElement>("proposal-rename-a-apply").click();
	ui.element<HTMLButtonElement>("proposal-rename-a-apply").click();
	await settle();
	const applyRequests = ui.requests.filter(({ path }) => path.endsWith("/apply"));
	assert.equal(applyRequests.length, 1);
	assert.equal(
		applyRequests[0]!.path,
		"/api/projects/project-a/datasets/dataset-a/conversations/chat-a/proposals/rename-a/apply",
	);
	assert.deepEqual(applyRequests[0]!.init, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: "preview-a", approved: true }),
	});
	assert.equal(ui.changes.length, 0);
	applying.resolve({ proposal: applied, dataset: nextDataset });
	await settle();
	assert.deepEqual(ui.changes, [nextDataset]);
	assert.match(
		ui.element("proposals").textContent ?? "",
		/Status: applied.*Output version: version-b.*Transform history/s,
	);
	assert.match(ui.element("proposals").textContent ?? "", /local-user · approved.*system · applied/s);
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, true);
	assert.match(ui.element("feedback").textContent ?? "", /Start a New chat/);
});

test("reject is local, needs no approval, and remains available for stale proposals", async (t) => {
	const value = renameProposal({ state: "stale", error: "The input version changed" });
	const rejected = renameProposal({
		...value,
		state: "rejected",
		audit: [...value.audit, { at: date, action: "rejected", actor: "local-user" }],
	});
	const ui = setup(t, {
		sessions: [saved()],
		proposals: [value],
		respond(path) {
			if (path.endsWith("/reject")) return rejected;
		},
	});
	ui.controller.update(uiContext({ ...dataset(), currentVersionId: "version-b" }));
	await settle();
	assert.match(ui.element("proposals").textContent ?? "", /The input version changed/);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-preview").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-reject").disabled, false);
	ui.element<HTMLButtonElement>("proposal-rename-a-reject").click();
	await settle();
	assert.deepEqual(
		ui.requests.filter(({ init }) => init.method === "POST"),
		[
			{
				path: "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/proposals/rename-a/reject",
				init: { method: "POST" },
			},
		],
	);
	assert.equal(ui.changes.length, 0);
	assert.match(ui.element("proposals").textContent ?? "", /Status: rejected.*local-user · rejected/s);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-reject").disabled, true);
});

test("approval resets on context, preview, reload and session changes without rendering proposal HTML", async (t) => {
	const unsafe = '<img src=x onerror="unsafe()">';
	let value = previewedProposal({ oldName: "<b>amount</b>", name: unsafe, error: "<script>failure()</script>" });
	value.preview!.sql = '<svg onload="unsafe()">';
	const ui = setup(t, {
		sessions: [saved(), saved("chat-b")],
		respond(path) {
			if (path.endsWith("/proposals") || path.endsWith("/preview"))
				return path.endsWith("/preview") ? value : [value];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("proposals").textContent ?? "", /<b>amount<\/b> → <img/);
	assert.equal(ui.element("proposals").querySelector("pre")!.textContent, value.preview!.sql);
	assert.equal(ui.element("proposals").querySelector("b, img, script, svg, table"), null);
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	ui.controller.update({ ...uiContext(), revision: 2 });
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	value = previewedProposal({ preview: { ...value.preview!, id: "preview-b" } });
	ui.element<HTMLButtonElement>("proposal-rename-a-preview").click();
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	assert.match(ui.element("proposals").querySelector("label")!.textContent ?? "", /preview-b/);
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	ui.element<HTMLButtonElement>("reload-proposals").click();
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-select")[1]!.click();
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/apply")).length, 0);
});

test("proposal loads and action responses cannot overwrite another session or dataset", async (t) => {
	const load = deferred<RenameProposal[]>();
	const action = deferred<RenameProposal>();
	const ui = setup(t, {
		sessions: [saved(), saved("chat-b")],
		respond(path) {
			if (path.includes("chat-a/proposals") && path.endsWith("/proposals")) return load.promise;
			if (path.includes("chat-b/proposals") && path.endsWith("/proposals"))
				return [renameProposal({ id: "rename-b", conversationId: "chat-b", name: "Other name" })];
			if (path.endsWith("/preview")) return action.promise;
			if (path.includes("dataset-b") && path.endsWith("/conversations")) return [];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-select")[1]!.click();
	await settle();
	load.resolve([renameProposal({ name: "STALE_LOAD" })]);
	await settle();
	assert.doesNotMatch(ui.element("proposals").textContent ?? "", /STALE_LOAD/);
	ui.element<HTMLButtonElement>("proposal-rename-b-preview").click();
	ui.controller.update(uiContext(dataset("dataset-b", "project-b")));
	action.resolve(previewedProposal({ id: "rename-b", name: "STALE_ACTION" }));
	await settle();
	assert.doesNotMatch(ui.container.textContent ?? "", /STALE_ACTION|Other name/);
	assert.equal(ui.changes.length, 0);
});

test("late apply responses do not refresh a different selected dataset", async (t) => {
	const action = deferred<{ proposal: RenameProposal; dataset: Dataset }>();
	const ui = setup(t, {
		sessions: [saved()],
		proposals: [previewedProposal()],
		respond(path) {
			if (path.endsWith("/apply")) return action.promise;
			if (path.includes("dataset-b") && path.endsWith("/conversations")) return [];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	ui.element<HTMLButtonElement>("proposal-rename-a-apply").click();
	ui.controller.update(uiContext(dataset("dataset-b", "project-b")));
	action.resolve({
		proposal: renameProposal({ state: "applied", name: "STALE_APPLY" }),
		dataset: { ...dataset(), currentVersionId: "version-b" },
	});
	await settle();
	assert.equal(ui.changes.length, 0);
	assert.doesNotMatch(ui.container.textContent ?? "", /STALE_APPLY/);
	assert.match(ui.element("context").textContent ?? "", /dataset-b/);
});

test("final streamed turns and reloads load proposals while historical sessions stay inspectable", async (t) => {
	let values: RenameProposal[] = [];
	const ui = setup(t, {
		respond(path) {
			if (path.endsWith("/proposals")) return values;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.change("message", "Rename amount to total");
	ui.submit();
	await settle();
	values = [renameProposal()];
	ui.complete("Review the proposed rename locally.");
	await settle();
	assert.match(ui.element("proposals").textContent ?? "", /Rename amount → total/);
	assert.ok(
		ui.requests.some(
			({ path }) => path === "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/proposals",
		),
	);
	const previous = saved();
	const applied = renameProposal({ state: "applied", outputVersionId: "version-b" });
	const reloaded = setup(t, { sessions: [previous], proposals: [applied] });
	reloaded.controller.update(uiContext({ ...dataset(), currentVersionId: "version-b" }));
	await settle();
	assert.match(reloaded.element("proposals").textContent ?? "", /Status: applied.*Output version: version-b/s);
	reloaded.change("message", "Cannot send old scope");
	reloaded.submit();
	assert.equal(reloaded.streams.length, 0);
	reloaded.element<HTMLButtonElement>("new").click();
	reloaded.container.querySelector<HTMLButtonElement>(".chat-session-list button")!.click();
	await settle();
	assert.match(reloaded.element("proposals").textContent ?? "", /Status: applied/);
	assert.equal(reloaded.element<HTMLButtonElement>("send").disabled, true);
});

test("expired previews and failed actions leave clear feedback and require fresh approval", async (t) => {
	const expired = previewedProposal();
	expired.preview!.expiresAt = "2000-01-01T00:00:00.000Z";
	let value = expired;
	const ui = setup(t, {
		sessions: [saved()],
		respond(path) {
			if (path.endsWith("/proposals")) return [value];
			if (path.endsWith("/preview")) {
				value = previewedProposal();
				return value;
			}
			if (path.endsWith("/apply")) {
				value = renameProposal({ state: "failed", error: "Version conflict" });
				return Promise.reject(new Error("Apply request failed"));
			}
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").disabled, true);
	assert.match(ui.element("proposals").textContent ?? "", /preview has expired/);
	ui.element<HTMLButtonElement>("proposal-rename-a-preview").click();
	await settle();
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	ui.element<HTMLButtonElement>("proposal-rename-a-apply").click();
	await settle();
	assert.match(ui.element("proposals").textContent ?? "", /Apply request failed.*Status: failed.*Version conflict/s);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-preview").disabled, false);
	assert.equal(ui.changes.length, 0);
});

test("empty successful proposal loads leave the transcript clear while loading remains visible", async (t) => {
	const renames = deferred<RenameProposal[]>();
	const charts = deferred<ChartProposal[]>();
	const ui = setup(t, {
		sessions: [saved()],
		respond(path) {
			if (path.endsWith("/proposals")) return renames.promise;
			if (path.endsWith("/chart-proposals")) return charts.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.equal(ui.element("proposals").hidden, false);
	assert.equal(ui.element("chart-proposals").hidden, false);
	assert.equal(ui.element("proposals").getAttribute("aria-busy"), "true");
	assert.equal(ui.element("chart-proposals").getAttribute("aria-busy"), "true");
	renames.resolve([]);
	charts.resolve([]);
	await settle();
	assert.equal(ui.element("proposals").hidden, true);
	assert.equal(ui.element("chart-proposals").hidden, true);
	assert.match(ui.element("activity").textContent ?? "", /No tool operations recorded/);
});

test("failed proposal loads expose a retry and never apply or reject automatically", async (t) => {
	let fail = true;
	const ui = setup(t, {
		sessions: [saved()],
		respond(path) {
			if (path.endsWith("/proposals"))
				return fail ? Promise.reject(new Error("Proposal history unavailable")) : [previewedProposal()];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("proposals").textContent ?? "", /Proposal history unavailable/);
	assert.equal(ui.element("proposals").hidden, false);
	assert.equal(ui.element<HTMLButtonElement>("reload-proposals").disabled, false);
	fail = false;
	ui.element<HTMLButtonElement>("reload-proposals").click();
	await settle();
	assert.match(ui.element("proposals").textContent ?? "", /Status: previewed/);
	assert.equal(ui.element("proposals").hidden, false);
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	assert.equal(
		ui.requests.some(({ init }) => init.method === "POST"),
		false,
	);
});

test("changing context while previewing discards the stale response and duplicate requests", async (t) => {
	const preview = deferred<RenameProposal>();
	const ui = setup(t, {
		sessions: [saved()],
		proposals: [renameProposal()],
		respond(path) {
			if (path.endsWith("/preview")) return preview.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.element<HTMLButtonElement>("proposal-rename-a-preview").click();
	ui.element<HTMLButtonElement>("proposal-rename-a-preview").click();
	ui.controller.update({ ...uiContext(), selectedColumns: [], filters: [], revision: 2 });
	await settle();
	preview.resolve(previewedProposal({ name: "STALE_PREVIEW" }));
	await settle();
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/preview")).length, 1);
	assert.doesNotMatch(ui.element("proposals").textContent ?? "", /STALE_PREVIEW/);
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-apply").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-preview").disabled, false);
	assert.equal(ui.changes.length, 0);
});

test("chart proposals resolve frozen evidence and render locally only after preview and approval", async (t) => {
	const session = saved();
	session.scope.context.evidence.push({
		id: "mean",
		metric: "mean",
		value: 5,
		columns: [0],
		basis: "sample",
		rows: 2,
		approximate: true,
	});
	const value = chartProposal({ evidenceRefs: ["rows", "mean"] });
	const preview = chartPreview({ evidenceRefs: value.evidenceRefs });
	const savedChart = chart();
	const saving = deferred<ConversationChartSaved>();
	const ui = setup(t, {
		sessions: [session],
		chartProposals: [value],
		proposals: [renameProposal()],
		respond(path) {
			if (path.endsWith("/chart-proposal-a/preview")) return preview;
			if (path.endsWith("/chart-proposal-a/save")) return saving.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	const panel = ui.element("chart-proposals");
	assert.match(
		panel.textContent ?? "",
		/Amount distribution.*Affected fields: amount.*Confidence: 80%.*evidence-linked.*not proof/s,
	);
	assert.match(panel.textContent ?? "", /rowCount: 2 · dataset · full data · 2 rows · not approximate/);
	assert.match(panel.textContent ?? "", /mean: 5 · amount · sample · 2 rows · approximate/);
	assert.deepEqual(
		JSON.parse(ui.element("chart-proposal-chart-proposal-a-spec").querySelector("pre")!.textContent!),
		value.spec,
	);
	assert.equal(panel.querySelector("svg"), null);
	assert.equal(ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").disabled, true);
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
	assert.equal(ui.requests.filter(({ init }) => init.method === "POST").length, 0);
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").focus();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	assert.deepEqual(
		ui.requests.find(({ path }) => path.endsWith("/chart-proposal-a/preview")),
		{
			path: "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/chart-proposals/chart-proposal-a/preview",
			init: { method: "POST" },
		},
	);
	assert.ok(ui.element("chart-proposal-chart-proposal-a-canvas").querySelector("figure.chart-figure svg .chart-mark"));
	assert.equal(ui.element<HTMLDetailsElement>("chart-proposal-chart-proposal-a-result").open, true);
	assert.equal(ui.document.activeElement?.id, "conversation-chart-proposal-chart-proposal-a-preview");
	assert.match(
		panel.textContent ?? "",
		/2 \/ 20 rows · sampled, not population estimates.*amount gt 4.*Null and invalid values excluded.*Only the bounded sample is shown/s,
	);
	assert.equal(
		ui.element("chart-proposal-chart-proposal-a-python").querySelector("pre")!.textContent,
		generateChartPython(preview.chart),
	);
	assert.doesNotMatch(panel.textContent ?? "", /PRIVATE_PREVIEW_CELL/);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, true);
	ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
	ui.change("message", "Do not send while saving");
	ui.submit();
	assert.equal(ui.streams.length, 0);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-preview").disabled, true);
	const posts = ui.requests.filter(({ path }) => path.endsWith("/chart-proposal-a/save"));
	assert.equal(posts.length, 1);
	assert.deepEqual(posts[0]!.init, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: "chart-preview-a", approved: true }),
	});
	saving.resolve({
		proposal: {
			...preview.proposal,
			state: "saved",
			chartId: savedChart.id,
			audit: [
				...preview.proposal.audit,
				{ at: date, actor: "local-user", action: "approved" },
				{ at: date, actor: "system", action: "saved" },
			],
		},
		chart: savedChart,
	});
	await settle();
	assert.deepEqual(ui.savedCharts, [savedChart]);
	assert.deepEqual(ui.changes, []);
	assert.match(
		panel.textContent ?? "",
		/Status: saved.*Open Visualize.*Dataset and version are unchanged.*local-user · approved.*system · saved/s,
	);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-reject").disabled, true);
	assert.match(ui.element("context").textContent ?? "", /Version: version-a/);
	assert.equal(ui.streams.length, 0);
	assert.doesNotMatch(JSON.stringify(ui.requests), /PRIVATE_PREVIEW_CELL|Observed count|import matplotlib/);
});

test("chart hypotheses and malicious text remain literal in evidence, specification and preview", async (t) => {
	const unsafe = '<img src=x onerror="unsafe()">';
	const session = saved();
	session.scope.context.schema = [{ ...dataset().schema[0]!, name: unsafe }];
	session.scope.context.evidence.push({
		id: "unsafe",
		metric: "label",
		value: unsafe,
		columns: [0],
		basis: "sample",
		rows: 1,
		approximate: true,
	});
	const preview = chartPreview({
		title: unsafe,
		explanation: "<script>bad()</script>",
		evidenceRefs: ["unsafe"],
		error: "<iframe src=x>",
		spec: { ...chartProposal().spec, filters: [{ column: 0, op: "eq", value: unsafe }] },
	});
	preview.chart.labels.x = unsafe;
	preview.chart.warnings = [unsafe];
	const hypothesis = chartProposal({
		id: "hypothesis",
		basis: "hypothesis",
		evidenceRefs: [],
		title: "Possible pattern",
	});
	const ui = setup(t, {
		sessions: [session],
		chartProposals: [preview.proposal, hypothesis],
		respond(path) {
			if (path.endsWith("/preview")) return preview;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.match(
		ui.element("chart-proposals").textContent ?? "",
		/Hypothesis: no supporting frozen metrics.*unverified inference/s,
	);
	assert.match(ui.element("chart-proposals").textContent ?? "", /label: <img/);
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	assert.ok(ui.element("chart-proposals").querySelector("svg"));
	assert.equal(ui.element("chart-proposals").querySelector("img, script, iframe, [onerror], [onload]"), null);
	assert.match(ui.element("chart-proposal-chart-proposal-a-canvas").textContent ?? "", /<img src=x/);
	assert.equal(ui.streams.length, 0);
});

test("chart approval resets on repreview, reload, context and session changes", async (t) => {
	let preview = chartPreview();
	const ui = setup(t, {
		sessions: [saved(), saved("chat-b")],
		respond(path) {
			if (path.endsWith("/chart-proposals")) return [preview.proposal];
			if (path.endsWith("/preview")) return preview;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("chart-proposals").textContent ?? "", /Only the saved preview receipt.*Preview again/s);
	assert.equal(ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").disabled, true);
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, false);
	preview = chartPreview({ preview: { ...preview.proposal.preview!, id: "chart-preview-b" } });
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	assert.equal(ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").checked, false);
	assert.match(ui.element("chart-proposals").querySelector("label")!.textContent ?? "", /chart-preview-b/);
	for (const invalidate of [
		() => ui.element<HTMLButtonElement>("reload-chart-proposals").click(),
		() => ui.controller.update({ ...uiContext(), revision: 2 }),
		() => ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-select")[1]!.click(),
	]) {
		ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
		invalidate();
		await settle();
		assert.equal(ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").checked, false);
		assert.equal(ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").disabled, true);
		assert.equal(ui.element("chart-proposals").querySelector("svg"), null);
		ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
		await settle();
	}
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/save")).length, 0);
});

test("stale chart proposals remain rejectable without preview or dataset mutation", async (t) => {
	const proposal = chartProposal({ state: "stale", error: "The input version changed" });
	const ui = setup(t, {
		sessions: [saved()],
		chartProposals: [proposal],
		respond(path) {
			if (path.endsWith("/reject"))
				return {
					...proposal,
					state: "rejected",
					audit: [...proposal.audit, { at: date, actor: "local-user", action: "rejected" }],
				};
		},
	});
	ui.controller.update(uiContext({ ...dataset(), currentVersionId: "version-b" }));
	await settle();
	assert.match(ui.element("chart-proposals").textContent ?? "", /stale dataset version/);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, true);
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-reject").click();
	await settle();
	assert.deepEqual(
		ui.requests.filter(({ init }) => init.method === "POST"),
		[
			{
				path: "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/chart-proposals/chart-proposal-a/reject",
				init: { method: "POST" },
			},
		],
	);
	assert.match(ui.element("chart-proposals").textContent ?? "", /Status: rejected.*local-user · rejected/s);
	assert.equal(ui.savedCharts.length, 0);
	assert.equal(ui.changes.length, 0);
	assert.equal(ui.streams.length, 0);
});

test("expired chart previews cannot save and failure reloads audit without phantom saves", async (t) => {
	let preview = chartPreview();
	preview.proposal.preview!.expiresAt = "2000-01-01T00:00:00.000Z";
	let server = preview.proposal;
	const ui = setup(t, {
		sessions: [saved()],
		respond(path) {
			if (path.endsWith("/chart-proposals")) return [server];
			if (path.endsWith("/preview")) return preview;
			if (path.endsWith("/save")) {
				server = chartProposal({ state: "failed", error: "Artifact changed" });
				return Promise.reject(new Error("Save failed"));
			}
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.match(ui.element("chart-proposals").textContent ?? "", /preview has expired/);
	assert.equal(ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").disabled, true);
	preview = chartPreview();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
	await settle();
	assert.match(ui.element("chart-proposals").textContent ?? "", /Save failed.*Status: failed.*Artifact changed/s);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").disabled, false);
	assert.equal(ui.savedCharts.length, 0);
});

test("chart loads and preview responses cannot replace another session or changed context", async (t) => {
	const load = deferred<ChartProposal[]>();
	const response = deferred<ConversationChartPreview>();
	const ui = setup(t, {
		sessions: [saved(), saved("chat-b")],
		respond(path) {
			if (path.endsWith("/chat-a/chart-proposals")) return load.promise;
			if (path.endsWith("/chat-b/chart-proposals")) return [chartProposal({ conversationId: "chat-b" })];
			if (path.endsWith("/preview")) return response.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-select")[1]!.click();
	await settle();
	load.resolve([chartProposal({ title: "STALE_LOAD" })]);
	await settle();
	assert.doesNotMatch(ui.element("chart-proposals").textContent ?? "", /STALE_LOAD/);
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	ui.controller.update({ ...uiContext(), revision: 2 });
	await settle();
	response.resolve(chartPreview({ title: "STALE_PREVIEW" }));
	await settle();
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/preview")).length, 1);
	assert.doesNotMatch(ui.element("chart-proposals").textContent ?? "", /STALE_PREVIEW/);
	assert.equal(ui.element("chart-proposals").querySelector("svg"), null);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").disabled, false);
});

test("late chart saves do not refresh another selected dataset", async (t) => {
	const saveResponse = deferred<ConversationChartSaved>();
	const preview = chartPreview();
	const ui = setup(t, {
		sessions: [saved(), saved("chat-b")],
		chartProposals: [chartProposal()],
		respond(path) {
			if (path.endsWith("/preview")) return preview;
			if (path.endsWith("/save")) return saveResponse.promise;
			if (path.includes("dataset-b") && path.endsWith("/conversations")) return [];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
	ui.controller.update(uiContext(dataset("dataset-b", "project-b")));
	saveResponse.resolve({
		proposal: { ...preview.proposal, title: "STALE_SAVE", state: "saved", chartId: "chart-a" },
		chart: chart(),
	});
	await settle();
	assert.equal(ui.savedCharts.length, 0);
	assert.equal(ui.changes.length, 0);
	assert.doesNotMatch(ui.container.textContent ?? "", /STALE_SAVE/);
	assert.match(ui.element("context").textContent ?? "", /dataset-b/);
});

test("late chart saves refresh the same dataset without replacing a new chat or another session", async (t) => {
	for (const switchTo of ["new", "other"] as const) {
		await t.test(switchTo, async (t) => {
			const saveResponse = deferred<ConversationChartSaved>();
			const preview = chartPreview();
			const other = saved("chat-b");
			other.title = "Other session";
			other.messages = [
				{
					id: "other-message",
					role: "assistant",
					text: "Keep this transcript",
					createdAt: date,
					state: "complete",
				},
			];
			const ui = setup(t, {
				sessions: [saved(), other],
				chartProposals: [chartProposal()],
				respond(path) {
					if (path.endsWith("/preview")) return preview;
					if (path.endsWith("/save")) return saveResponse.promise;
					if (path.endsWith("/chat-b/chart-proposals")) return [];
				},
			});
			ui.controller.update(uiContext());
			await settle();
			ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
			await settle();
			ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
			ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
			if (switchTo === "new") ui.element<HTMLButtonElement>("new").click();
			else ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-select")[1]!.click();
			await settle();
			ui.change("message", "Keep this draft");
			const transcript = ui.container.querySelector(".assistant-history")!.textContent;
			const savedChart = chart();
			saveResponse.resolve({
				proposal: { ...preview.proposal, title: "STALE_SAVE", state: "saved", chartId: savedChart.id },
				chart: savedChart,
			});
			await settle();
			assert.deepEqual(ui.savedCharts, [savedChart]);
			assert.equal(ui.container.querySelector(".assistant-history")!.textContent, transcript);
			assert.equal(ui.element<HTMLTextAreaElement>("message").value, "Keep this draft");
			assert.doesNotMatch(ui.container.textContent ?? "", /STALE_SAVE/);
			assert.equal(ui.changes.length, 0);
			assert.equal(ui.streams.length, 0);
			if (switchTo === "new") assert.equal(ui.element("chart-proposals").hidden, true);
			else
				assert.equal(
					ui.container.querySelector('.chat-session-list button[aria-current="true"]')!.textContent,
					"Other session",
				);
		});
	}
});

test("final streamed turns fetch chart proposals and failed history loads allow retry", async (t) => {
	let fail = true;
	const ui = setup(t, {
		respond(path) {
			if (path.endsWith("/chart-proposals"))
				return fail ? Promise.reject(new Error("Chart proposals unavailable")) : [chartProposal()];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.change("message", "Suggest a chart");
	ui.submit();
	await settle();
	ui.complete("Review the chart locally.");
	await settle();
	assert.match(ui.element("chart-proposals").textContent ?? "", /Chart proposals unavailable/);
	assert.equal(ui.element("chart-proposals").hidden, false);
	fail = false;
	ui.element<HTMLButtonElement>("reload-chart-proposals").click();
	await settle();
	assert.match(ui.element("chart-proposals").textContent ?? "", /Amount distribution/);
	assert.equal(ui.element("chart-proposals").hidden, false);
	assert.equal(ui.element("chart-proposals").querySelector("svg"), null);
	assert.equal(ui.requests.filter(({ init }) => init.method === "POST").length, 1);
	assert.equal(ui.streams.length, 1);
});

test("chart save rechecks expiry even when approval was granted before expiration", async (t) => {
	const preview = chartPreview();
	const ui = setup(t, {
		sessions: [saved()],
		chartProposals: [chartProposal()],
		respond(path) {
			if (path.endsWith("/preview")) return preview;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-preview").click();
	await settle();
	ui.element<HTMLInputElement>("chart-proposal-chart-proposal-a-approve").click();
	assert.equal(ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").disabled, false);
	t.mock.method(Date, "now", () => Date.parse("2100-01-01T00:00:00.000Z"));
	ui.element<HTMLButtonElement>("chart-proposal-chart-proposal-a-save").click();
	await settle();
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/save")).length, 0);
	assert.equal(ui.savedCharts.length, 0);
});

test("sessions display relative timestamps with absolute dates available on hover", async (t) => {
	const value = saved();
	value.updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	const ui = setup(t, { sessions: [value] });
	ui.controller.update(uiContext());
	await settle();
	const meta = ui.container.querySelector<HTMLElement>(".chat-session-meta")!;
	const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" }).format(-3, "hour");
	assert.equal(meta.textContent, `ready · ${relative}`);
	assert.equal(meta.title, new Date(value.updatedAt).toLocaleString());
	assert.equal(meta.parentElement!.dataset.state, "ready");
});

test("session search, rename, duplicate and confirmed archive use persistent endpoints", async (t) => {
	let value = saved();
	const ui = setup(t, {
		sessions: [value],
		respond(path, init) {
			if (init.method === "PATCH") {
				value = { ...value, title: JSON.parse(String(init.body)).title };
				return value;
			}
			if (path.endsWith("/duplicate")) return { ...value, id: "copy-a", title: "Copy of session" };
			if (path.endsWith("/archive")) return { ...value, archivedAt: date };
		},
	});
	ui.controller.update(uiContext());
	await settle();
	const button = (text: string) =>
		[...ui.container.querySelectorAll<HTMLButtonElement>(".chat-session-menu button")].find(
			(item) => item.textContent === text,
		)!;
	button("Rename").click();
	const rename = ui.container.querySelector<HTMLFormElement>(".chat-session-rename")!;
	rename.querySelector("input")!.value = "Quality investigation";
	rename.dispatchEvent(new ui.browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
	await settle();
	assert.equal(ui.container.querySelector(".chat-header h2")!.textContent, "Quality investigation");
	assert.deepEqual(JSON.parse(String(ui.requests.find(({ init }) => init.method === "PATCH")!.init.body)), {
		title: "Quality investigation",
	});
	ui.change("search", "not present");
	assert.equal(ui.container.querySelectorAll(".chat-session-select").length, 0);
	ui.change("search", "");
	button("Duplicate").click();
	await settle();
	assert.equal(ui.container.querySelectorAll(".chat-session-select").length, 2);
	assert.equal(ui.container.querySelector(".chat-header h2")!.textContent, "Copy of session");
	button("Delete…").click();
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/archive")).length, 0);
	button("Keep session").click();
	button("Delete…").click();
	button("Delete session").click();
	await settle();
	assert.equal(ui.requests.filter(({ path }) => path.endsWith("/archive")).length, 1);
	assert.equal(ui.requests.filter(({ init }) => init.method === "DELETE").length, 0);
	assert.equal(ui.container.querySelectorAll(".chat-session-select").length, 1);
});

test("exports omit internal paths, attachment contents and screenshot bytes", () => {
	const value = saved();
	value.sessionFile = "PRIVATE_INTERNAL_SESSION_PATH";
	value.scope.context.attachedFiles = [
		{
			name: "notes.txt",
			mediaType: "text/plain",
			content: "PRIVATE_ATTACHMENT",
			byteLength: 18,
			sha256: "a".repeat(64),
		},
	];
	value.scope.screenshots = [
		{
			name: "screen.png",
			mediaType: "image/png",
			data: "PRIVATE_IMAGE_BYTES",
			byteLength: 16,
			sha256: "b".repeat(64),
		},
	];
	value.messages = [{ id: "m", role: "assistant", text: "A useful answer", state: "complete", createdAt: date }];
	for (const format of ["json", "markdown"] as const) {
		const exported = exportConversation(value, format);
		assert.match(exported, /A useful answer/);
		assert.doesNotMatch(exported, /PRIVATE_|sessionFile|apiKey/);
	}
	const result = JSON.parse(exportConversation(value, "json"));
	assert.equal(result.scope.screenshots[0].sha256, "b".repeat(64));
	assert.equal("data" in result.scope.screenshots[0], false);
});

test("mode and reasoning persist with server enforcement and recover from errors", async (t) => {
	let value = { ...saved(), mode: "execute" as const } as Conversation;
	let fail = false;
	const ui = setup(t, {
		sessions: [value],
		proposals: [previewedProposal()],
		respond(_path, init) {
			if (init.method === "PATCH") {
				if (fail) return Promise.reject(new Error("Settings unavailable"));
				value = { ...value, ...JSON.parse(String(init.body)) };
				return value;
			}
		},
	});
	ui.controller.update(uiContext());
	await settle();
	const mode = ui.element<HTMLSelectElement>("mode");
	mode.value = "plan";
	mode.dispatchEvent(new ui.browser.Event("change") as unknown as Event);
	await settle();
	assert.match(ui.element("mode-note").textContent ?? "", /read only/);
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-preview").disabled, true);
	assert.equal(ui.element<HTMLButtonElement>("proposal-rename-a-reject").disabled, false);
	const reasoning = ui.element<HTMLSelectElement>("reasoning");
	reasoning.value = "high";
	reasoning.dispatchEvent(new ui.browser.Event("change") as unknown as Event);
	await settle();
	assert.deepEqual(JSON.parse(String(ui.requests.filter(({ init }) => init.method === "PATCH").at(-1)!.init.body)), { mode: "plan" });
	assert.deepEqual(JSON.parse(String(ui.requests.filter(({ init }) => init.method === "PUT").at(-1)!.init.body)), {
		provider: "test", modelId: "model", thinkingLevel: "high", persist: false,
	});
	fail = true;
	mode.value = "execute";
	mode.dispatchEvent(new ui.browser.Event("change") as unknown as Event);
	await settle();
	assert.equal(mode.value, "plan");
	assert.match(ui.element("feedback").textContent ?? "", /Settings unavailable/);
});

test("agent prompt roles preview the exact submitted message and editing does not duplicate instructions", async (t) => {
	const ui = setup(t);
	ui.controller.update(uiContext());
	await settle();
	const agent = ui.element<HTMLSelectElement>("agent");
	assert.deepEqual(
		[...agent.options].map((item) => item.textContent),
		["Pi Analyst", "Pi Reviewer"],
	);
	assert.equal(agent.closest(".chat-composer-tools"), ui.container.querySelector(".chat-composer-tools"));
	assert.equal(
		ui.element<HTMLTextAreaElement>("message").placeholder,
		"Ask Pi to analyze, transform, visualize, or explain…",
	);
	assert.equal(ui.element("key-hint").textContent, "Enter to send · Shift+Enter for new line");
	ui.change("message", "Check this analysis");
	assert.equal(ui.element("agent-instructions").textContent, `${analystInstructions}\n\nCheck this analysis`);
	agent.value = "reviewer";
	agent.dispatchEvent(new ui.browser.Event("change") as unknown as Event);
	const reviewedMessage = `${reviewerInstructions}\n\nCheck this analysis`;
	assert.equal(ui.element("agent-instructions").textContent, reviewedMessage);
	assert.equal(
		ui.requests.some(({ init }) => init.method === "POST"),
		false,
	);
	assert.equal(ui.streams.length, 0);
	ui.submit();
	await settle();
	assert.equal(ui.streams[0]!.message, reviewedMessage);
	assert.equal(
		JSON.parse(String(ui.requests.find(({ init }) => init.method === "POST")!.init.body)).request,
		"Check this analysis",
	);
	assert.equal(ui.container.querySelector(".chat-session-select")?.textContent, "Check this analysis");
	assert.equal(ui.container.querySelector(".chat-header h2")?.textContent, "Check this analysis");
	assert.equal(agent.disabled, true);
	assert.match(ui.container.querySelector(".assistant-history")!.textContent ?? "", /Act as Pi Reviewer/);
	ui.complete();
	await settle();
	assert.equal(agent.disabled, false);
	[...ui.container.querySelectorAll<HTMLButtonElement>(".chat-message-actions button")]
		.find((button) => button.textContent === "Edit & resend")!
		.click();
	assert.equal(ui.element<HTMLTextAreaElement>("message").value, "Check this analysis");
	assert.equal(agent.value, "reviewer");
	assert.equal(ui.element("agent-instructions").textContent, reviewedMessage);
	agent.value = "analyst";
	agent.dispatchEvent(new ui.browser.Event("change") as unknown as Event);
	ui.submit();
	await settle();
	assert.equal(ui.streams[1]!.message, `${analystInstructions}\n\nCheck this analysis`);
	assert.equal(ui.requests.filter(({ init }) => init.method === "POST").length, 1);
	ui.complete();
	await settle();
	ui.element<HTMLButtonElement>("new").click();
	assert.equal(agent.value, "analyst");
});

test("composer model selection retains one control and revokes attachment consent before using the chosen model", async (t) => {
	const ui = setup(t, { models: [availableModel(), availableModel({ id: "alternate", name: "Alternate" })] });
	ui.controller.update(uiContext());
	await settle();
	const model = ui.element<HTMLButtonElement>("model");
	assert.equal(model.closest(".chat-composer-tools"), ui.container.querySelector(".chat-composer-tools"));
	assert.equal(ui.element("context-panel").contains(model), false);
	assert.equal(ui.document.querySelectorAll("#conversation-model").length, 1);
	ui.change("message", "Inspect the files");
	const image = { ...ui.textFile("screen.png", Uint8Array.of(137, 80, 78, 71)), type: "image/png" };
	ui.choose([ui.textFile("notes.txt", "local text"), image]);
	await settle();
	ui.element<HTMLInputElement>("file-consent").click();
	ui.element<HTMLInputElement>("screenshot-consent").click();
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, false);
	await ui.selectModel("Alternate");
	assert.equal(ui.element("model"), model);
	assert.equal(ui.element<HTMLInputElement>("file-consent").checked, false);
	assert.equal(ui.element<HTMLInputElement>("screenshot-consent").checked, false);
	ui.submit();
	await settle();
	assert.equal(
		ui.requests.some(({ init }) => init.method === "POST"),
		false,
	);
	ui.element<HTMLInputElement>("file-consent").click();
	ui.element<HTMLInputElement>("screenshot-consent").click();
	ui.submit();
	await settle();
	assert.equal(
		JSON.parse(String(ui.requests.find(({ init }) => init.method === "POST")!.init.body)).modelId,
		"alternate",
	);
	assert.equal(ui.element("model"), model);
	assert.equal(model.textContent, "Alternate");
	assert.equal(model.disabled, true);
	ui.complete();
	await settle();
	assert.equal(model.disabled, false);
	ui.element<HTMLButtonElement>("new").click();
	await settle();
	assert.equal(ui.element("model"), model);
	assert.equal(model.disabled, false);
});

test("model changes await the real session endpoint and retain current state after rejection", async (t) => {
	const next = availableModel({ provider: "future-pi-provider", id: "future-model", name: "Future model", thinkingLevels: ["off", "xhigh"] });
	const pending = deferred<SessionModelState>();
	const ui = setup(t, {
		models: [availableModel(), next],
		respond(path, init) {
			if (path === "/api/chat/model" && init.method === "PUT") return pending.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.change("message", "Unsent draft");
	const originalContext = ui.element("context").textContent;
	await ui.chooseModel("Future model");
	const thinking = ui.document.querySelector<HTMLSelectElement>('select[aria-label="Thinking level"]');
	assert.ok(thinking);
	assert.deepEqual([...thinking.options].map((item) => item.value), ["off", "xhigh"]);
	ui.applyModel();
	await settle();
	assert.deepEqual(JSON.parse(String(ui.requests.find(({ init }) => init.method === "PUT")!.init.body)), {
		provider: "future-pi-provider", modelId: "future-model", thinkingLevel: "off", persist: false,
	});
	assert.equal(ui.element("model").textContent, "Model");
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, true);
	assert.equal(ui.streams.length, 0);
	assert.equal(ui.element("context").textContent, originalContext);
	pending.reject(new Error("Model unavailable"));
	await settle();
	assert.equal(ui.element("model").textContent, "Model");
	assert.match(ui.document.body.textContent ?? "", /session model could not be changed/i);
	assert.doesNotMatch(ui.document.body.textContent ?? "", /Model unavailable/);
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, true);
	assert.equal(ui.element<HTMLTextAreaElement>("message").value, "Unsent draft");
	assert.equal(ui.requests.some(({ init }) => init.method === "POST"), false);
});

test("saved session hydrates authoritative current model and displays Auto physical dispatch", async (t) => {
	const previous = saved();
	const auto = availableModel({ provider: "router", id: "auto", name: "Auto", virtual: true, billing: "virtual", thinkingLevels: ["low", "high"] });
	const state: SessionModelState = { model: auto, thinkingLevel: "high", routedModel: { provider: "future-provider", id: "actual-model", name: "Actual physical model", thinkingLevel: "high" } };
	previous.messages = [{ id: "answer", role: "assistant", text: "Saved answer", state: "complete", createdAt: date, model: state.routedModel }];
	const ui = setup(t, {
		sessions: [previous],
		models: [availableModel(), auto],
		respond(path, init) {
			if (path.endsWith("/conversations/chat-a/model") && !init.method) return state;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	assert.equal(ui.element("model").textContent, "Auto — Pi chooses → Actual physical model");
	assert.equal(ui.element<HTMLSelectElement>("reasoning").value, "high");
	assert.match(ui.container.querySelector(".chat-message-header")?.textContent ?? "", /Actual physical model.*future-provider \/ actual-model/);
	assert.match(ui.container.querySelector(".chat-consent-summary")?.textContent ?? "", /Auto.*any available configured provider/);
	assert.match(ui.element("context").textContent ?? "", /Original disclosure provider: test \/ model/);
	assert.equal(ui.streams.length, 0);
	assert.equal(ui.requests.some(({ init }) => init.method), false);
});

test("provider entry points work without a dataset and do not create a chat", async (t) => {
	const ui = setup(t);
	await ui.controller.initialize();
	ui.document.dispatchEvent(new ui.browser.CustomEvent("workbench:open-settings") as unknown as Event);
	await settle();
	assert.ok(ui.document.querySelector('dialog[open][aria-modal="true"]'));
	assert.equal(ui.requests.some(({ path }) => path === "/api/providers"), true);
	ui.closeProviders();
	ui.element<HTMLButtonElement>("provider").click();
	await settle();
	assert.ok(ui.document.querySelector('dialog[open][aria-modal="true"]'));
	ui.closeProviders();
	ui.element<HTMLButtonElement>("model").click();
	await settle();
	assert.ok(ui.document.querySelector('input[aria-label="Search models"]'));
	assert.equal(ui.streams.length, 0);
	assert.equal(ui.requests.some(({ init }) => init.method), false);
	assert.equal(ui.document.querySelector("#conversation-api-key"), null);
});

test("empty available catalog connection CTA opens Providers without sending context", async (t) => {
	const ui = setup(t, { models: [], draftModelState: { model: null, thinkingLevel: "off", routedModel: null } });
	ui.controller.update(uiContext());
	await settle();
	const connect = [...ui.container.querySelectorAll<HTMLButtonElement>(".assistant-history button")].find((item) => item.textContent === "Connect a provider");
	assert.ok(connect);
	connect.click();
	await settle();
	assert.ok(ui.document.querySelector('dialog[open][aria-modal="true"]'));
	assert.equal(ui.requests.some(({ path }) => path === "/api/providers"), true);
	assert.equal(ui.streams.length, 0);
	assert.equal(ui.requests.some(({ init }) => init.method), false);
});

test("existing session selection commits only authoritative state and does not mutate frozen context", async (t) => {
	const next = availableModel({ provider: "new-provider", id: "new-id", name: "New catalog model", thinkingLevels: ["low", "high"] });
	const pending = deferred<SessionModelState>();
	const previous = saved();
	const original = structuredClone(previous.scope);
	const ui = setup(t, {
		sessions: [previous], models: [availableModel(), next],
		respond(path, init) {
			if (path.endsWith("/conversations/chat-a/model") && init.method === "PUT") return pending.promise;
		},
	});
	ui.controller.update(uiContext());
	await settle();
	const contextBefore = ui.element("context").textContent;
	await ui.chooseModel("New catalog model");
	const defaults = [...ui.document.querySelectorAll<HTMLLabelElement>("dialog label")].find((label) => label.textContent?.includes("Use as default for new sessions"))?.querySelector<HTMLInputElement>("input");
	assert.ok(defaults);
	assert.equal(defaults.checked, false);
	defaults.click();
	ui.applyModel();
	await settle();
	const selection = ui.requests.find(({ init }) => init.method === "PUT");
	assert.ok(selection);
	assert.equal(selection.path, "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/model");
	assert.equal(JSON.parse(String(selection.init.body)).persist, true);
	assert.equal(ui.element("model").textContent, "Model");
	const confirmed = { ...next, name: "Authoritative Pi name" };
	pending.resolve({ model: confirmed, thinkingLevel: "high", routedModel: null });
	await settle();
	assert.equal(ui.element("model").textContent, "Authoritative Pi name");
	assert.equal(ui.element<HTMLSelectElement>("reasoning").value, "high");
	assert.equal(ui.element("context").textContent, contextBefore);
	assert.deepEqual(previous.scope, original);
	assert.match(ui.container.querySelector(".chat-consent-summary")?.textContent ?? "", /Next Send: new-provider \/ new-id/);
	assert.equal(ui.streams.length, 0);
	assert.equal(ui.requests.some(({ init }) => init.method === "POST"), false);
});

test("failed current-model hydration blocks Send instead of trusting a stale saved selection", async (t) => {
	const ui = setup(t, {
		sessions: [saved()],
		respond(path) {
			if (path.endsWith("/conversations/chat-a/model")) return Promise.reject(new Error("Current model unavailable"));
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.change("message", "Do not send through a stale recipient");
	assert.equal(ui.element<HTMLButtonElement>("send").disabled, true);
	ui.submit();
	await settle();
	assert.match(ui.element("feedback").textContent ?? "", /Current model unavailable/);
	assert.equal(ui.streams.length, 0);
});

test("late model hydration cannot overwrite another dataset's authoritative selection", async (t) => {
	const pending = deferred<SessionModelState>();
	const future = availableModel({ provider: "next-provider", id: "next-model", name: "Next model" });
	const ui = setup(t, {
		sessions: [saved()], models: [availableModel(), future], draftModelState: selectedModel(future),
		respond(path) {
			if (path.endsWith("/conversations/chat-a/model")) return pending.promise;
			if (path.includes("project-b") && path.endsWith("/conversations")) return [];
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.controller.update(uiContext(dataset("dataset-b", "project-b")));
	await settle();
	assert.equal(ui.element("model").textContent, "Next model");
	pending.resolve(selectedModel());
	await settle();
	assert.equal(ui.element("model").textContent, "Next model");
	assert.match(ui.container.querySelector(".chat-consent-summary")?.textContent ?? "", /Next Send: next-provider \/ next-model/);
	assert.equal(ui.streams.length, 0);
});

test("composer keyboard is configurable and text entry preserves transcript and session nodes", async (t) => {
	const value = saved();
	value.messages = [{ id: "a", role: "assistant", text: "Existing answer", createdAt: date, state: "complete" }];
	const ui = setup(t, {
		sessions: [value],
		keybindings: { sendMessage: [{ key: "Enter", ctrl: true }], newline: [{ key: "Enter" }] },
	});
	ui.controller.update(uiContext());
	await settle();
	assert.equal(ui.element("key-hint").textContent, "Ctrl+Enter to send · Enter for new line");
	const article = ui.container.querySelector("[data-message-id=a]");
	const session = ui.container.querySelector(".chat-session-select");
	ui.change("message", "Question");
	assert.equal(ui.container.querySelector("[data-message-id=a]"), article);
	assert.equal(ui.container.querySelector(".chat-session-select"), session);
	const input = ui.element<HTMLTextAreaElement>("message");
	input.setSelectionRange(8, 8);
	input.dispatchEvent(
		new ui.browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event,
	);
	assert.equal(input.value, "Question\n");
	assert.equal(ui.streams.length, 0);
	input.dispatchEvent(
		new ui.browser.KeyboardEvent("keydown", {
			key: "Enter",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		}) as unknown as Event,
	);
	await settle();
	assert.equal(ui.streams.length, 1);
	ui.complete();
});

test("autocomplete references actual context and workflows only create drafts or local navigation", async (t) => {
	const ui = setup(t);
	ui.controller.update(uiContext());
	await settle();
	const input = ui.element<HTMLTextAreaElement>("message");
	input.value = "@";
	input.setSelectionRange(1, 1);
	input.dispatchEvent(new ui.browser.Event("input") as unknown as Event);
	assert.match(ui.element("suggestions").textContent ?? "", /dataset-a.*amount.*Saved chart/s);
	assert.doesNotMatch(ui.element("suggestions").textContent ?? "", /notebook|result-a/);
	ui.element("suggestions").querySelector<HTMLButtonElement>("button")!.click();
	assert.match(input.value, /@dataset:dataset-a/);
	input.value = "/quality";
	input.setSelectionRange(8, 8);
	input.dispatchEvent(new ui.browser.Event("input") as unknown as Event);
	ui.element("suggestions").querySelector<HTMLButtonElement>("button")!.click();
	assert.match(input.value, /missingness/);
	assert.equal(ui.streams.length, 0);
	assert.equal(
		ui.requests.some(({ init }) => init.method === "POST"),
		false,
	);
});

test("dropped text and pasted screenshots remain local and require separate consent", async (t) => {
	const ui = setup(t);
	ui.controller.update(uiContext());
	await settle();
	ui.change("message", "Inspect these attachments");
	const drop = new ui.browser.Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(drop, "dataTransfer", { value: { files: [ui.textFile("notes.txt", "local text")] } });
	ui.container.querySelector(".assistant-form")!.dispatchEvent(drop as unknown as Event);
	await settle();
	const image = { ...ui.textFile("screen.png", Uint8Array.of(137, 80, 78, 71)), type: "image/png" };
	const paste = new ui.browser.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: { files: [image] } });
	ui.element("message").dispatchEvent(paste as unknown as Event);
	await settle();
	assert.ok(ui.element("screenshots").querySelector("img")?.src.startsWith("data:image/png;base64,"));
	assert.equal(ui.element<HTMLElement>("context-panel").hidden, false);
	ui.element<HTMLInputElement>("file-consent").click();
	ui.submit();
	await settle();
	assert.equal(ui.streams.length, 0);
	ui.element<HTMLInputElement>("screenshot-consent").click();
	ui.submit();
	await settle();
	const payload = JSON.parse(String(ui.requests.find(({ init }) => init.method === "POST")!.init.body));
	assert.equal(payload.screenshotConsent, true);
	assert.equal(payload.screenshots[0].data, "iVBORw==");
	assert.equal(payload.attachments[0].content, "local text");
	assert.equal(ui.streams[0]!.message, `${analystInstructions}\n\nInspect these attachments`);
	ui.complete();
	await settle();
	assert.match(ui.element("screenshots").textContent ?? "", /SHA-256/);
});

test("feedback persists locally and editing does not mutate saved history or send automatically", async (t) => {
	const value = saved();
	value.messages = [
		{ id: "u", role: "user", text: "Original question", createdAt: date, state: "complete" },
		{ id: "a", role: "assistant", text: "Answer", createdAt: date, state: "complete" },
	];
	const ui = setup(t, { sessions: [value] });
	ui.controller.update(uiContext());
	await settle();
	const actions = [...ui.container.querySelectorAll<HTMLButtonElement>(".chat-message-actions button")];
	actions.find((item) => item.textContent === "Helpful")!.click();
	assert.equal(ui.browser.localStorage.getItem("datapi:feedback:project-a:dataset-a:chat-a:a"), "helpful");
	assert.match(ui.element("feedback").textContent ?? "", /locally.*browser only/);
	actions.find((item) => item.textContent === "Edit & resend")!.click();
	assert.equal(ui.element<HTMLTextAreaElement>("message").value, "Original question");
	assert.equal(ui.streams.length, 0);
	assert.equal(value.messages[0]!.text, "Original question");
});

test("session grants stay exact, never execute automatically and reset across context changes", async (t) => {
	const ui = setup(t, { sessions: [saved()], proposals: [previewedProposal()] });
	ui.controller.update(uiContext());
	await settle();
	ui.element<HTMLButtonElement>("proposal-rename-a-always").click();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, true);
	assert.equal(
		ui.requests.some(({ path }) => path.endsWith("/apply")),
		false,
	);
	ui.element<HTMLInputElement>("proposal-rename-a-approve").click();
	ui.element<HTMLButtonElement>("reload-proposals").click();
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
	ui.element<HTMLButtonElement>("proposal-rename-a-always").click();
	ui.controller.update({ ...uiContext(), revision: 2 });
	await settle();
	assert.equal(ui.element<HTMLInputElement>("proposal-rename-a-approve").checked, false);
});

test("dataset selector uses real context choices and delegates selection", async (t) => {
	const selected: string[] = [];
	const ui = setup(t, {
		onDatasetSelected(id) {
			selected.push(id);
		},
	});
	ui.controller.update({
		...uiContext(),
		datasets: [
			{ id: "dataset-a", name: "Current" },
			{ id: "dataset-b", name: "Other dataset" },
		],
	});
	await settle();
	const select = ui.element<HTMLSelectElement>("dataset");
	assert.equal(select.options.length, 2);
	select.value = "dataset-b";
	select.dispatchEvent(new ui.browser.Event("change") as unknown as Event);
	await settle();
	assert.deepEqual(selected, ["dataset-b"]);
});
