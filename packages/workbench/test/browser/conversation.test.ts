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
import { type ConversationUiContext, initializeConversation } from "../../src/browser/conversation.ts";
import type { ChartRecord } from "../../src/chart-contracts.ts";
import { defaultChartSpec } from "../../src/chart-spec.ts";
import type { Dataset } from "../../src/contracts.ts";
import type { Conversation, ConversationEvent } from "../../src/conversation-contracts.ts";
import type { TransformRecord } from "../../src/transform-contracts.ts";

const date = "2026-09-24T00:00:00.000Z";
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
	config: { sessions?: Conversation[]; respond?: Respond; records?: TransformRecord[] } = {},
) {
	const browser = new TestWindow({ url: "http://localhost:4310", width: 360, height: 900 });
	const document = browser.document as unknown as Document;
	const container = document.createElement("div");
	document.body.append(container);
	const requests: { path: string; init: RequestInit }[] = [];
	const streams: {
		path: string;
		message: string;
		onEvent: (event: ConversationEvent) => void;
		completion: ReturnType<typeof deferred<Conversation>>;
	}[] = [];
	let serverConversation = saved();
	const controller = initializeConversation(container, {
		async api<T>(path: string, init: RequestInit = {}): Promise<T> {
			requests.push({ path, init });
			const response = config.respond?.(path, init);
			if (response !== undefined) return (await response) as T;
			if (path === "/api/chat/models")
				return {
					models: [{ provider: "test", id: "model", name: "Model", configured: true, contextWindow: 32000 }],
					guidance: "",
				} as T;
			if (path.endsWith("/charts")) return [chart()] as T;
			if (path.endsWith("/transforms/history"))
				return {
					currentVersionId: "version-a",
					canUndo: false,
					canRedo: false,
					records: config.records ?? [record()],
				} as T;
			if (path.endsWith("/conversations") && !init.method) return (config.sessions ?? []) as T;
			if (path.endsWith("/conversations") && init.method === "POST") {
				const selection = JSON.parse(String(init.body)) as AssistantSelection;
				serverConversation = saved();
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
			.querySelector("form")!
			.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
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
		element,
		change,
		choose,
		textFile,
		submit,
		complete,
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
		attachments: [{ name: "notes.md", mediaType: "text/plain", content }],
		executionIds: ["result-a"],
	});
	assert.equal(ui.streams[0]!.path, "/api/projects/project-a/datasets/dataset-a/conversations/chat-a/messages");
	assert.equal(ui.streams[0]!.message, "Explain this file");
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
	assert.equal(ui.streams[1]!.message, "Follow up");
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
	assert.equal(ui.element<HTMLSelectElement>("provider").value, "test");
	assert.equal(ui.element<HTMLSelectElement>("model").value, "model");
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
	const ui = setup(t, {
		respond(path) {
			if (path === "/api/chat/models")
				return {
					models: ["test", "other"].map((provider) => ({
						provider,
						id: "model",
						name: "Model",
						configured: true,
						contextWindow: 32000,
					})),
				};
		},
	});
	ui.controller.update(uiContext());
	await settle();
	ui.choose([ui.textFile("one.txt", "one"), ui.textFile("two.txt", "two")]);
	await settle();
	ui.element<HTMLInputElement>("file-consent").click();
	ui.element("file-list").querySelector<HTMLButtonElement>("button")!.click();
	assert.equal(ui.element<HTMLInputElement>("file-consent").checked, false);
	assert.doesNotMatch(ui.element("file-list").textContent ?? "", /one.txt/);
	ui.element<HTMLInputElement>("file-consent").click();
	ui.element<HTMLSelectElement>("provider").value = "other";
	ui.element("provider").dispatchEvent(new ui.browser.Event("change") as unknown as Event);
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
	assert.equal(ui.element<HTMLSelectElement>("provider").value, "test");
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
