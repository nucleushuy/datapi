import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { Window as TestWindow } from "happy-dom";
import { exportChart } from "../../src/browser/chart-export.ts";
import { renderChart } from "../../src/browser/chart-renderer.ts";
import type { ChartMark, ChartResult, ChartType } from "../../src/chart-contracts.ts";

function setup(t: TestContext) {
	const browser = new TestWindow({
		url: "http://localhost:4310",
		settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
	});
	const document = browser.document as unknown as Document;
	const container = document.createElement("div");
	document.body.append(container);
	t.after(() => browser.happyDOM.close());
	return { browser, document, container };
}
function mark(patch: Partial<ChartMark> = {}): ChartMark {
	return {
		x: "A",
		y: 4,
		value: 4,
		color: null,
		size: null,
		facet: null,
		low: null,
		high: null,
		q1: null,
		median: null,
		q3: null,
		rowIds: [2, 5],
		...patch,
	};
}
function result(type: ChartType, marks: ChartMark[] = [mark()]): ChartResult {
	return {
		spec: {
			version: 1,
			datasetVersionId: "version-a",
			type,
			x: 0,
			y: 1,
			color: null,
			size: null,
			facet: null,
			aggregation: "count",
			sort: "ascending",
			filters: [],
			bins: 20,
			categoryLimit: 20,
			zeroBaseline: true,
			xMin: null,
			yMin: null,
		},
		datasetVersionHash: "a".repeat(64),
		generatedAt: "2026-01-01T00:00:00.000Z",
		populationRows: 1000,
		sampleSize: 100,
		stride: 10,
		byteLimited: false,
		sampled: true,
		filteredRows: 40,
		excludedRows: 3,
		omittedMarks: 0,
		marks,
		table: { columns: [], rows: [] },
		warnings: ["Sampled data; counts are not population estimates."],
		labels: {
			x: "Source category",
			y: "Source amount",
			color: "Source region",
			size: "Source weight",
			facet: "Source segment",
			aggregation: "Count",
			filters: "Source amount > 2",
			missing: "Excluded missing numeric values",
		},
	};
}

for (const type of ["histogram", "box", "bar", "line", "scatter", "heatmap", "correlation", "missingness"] as const) {
	test(`${type} renders real selectable marks, field axes and accessible context`, (t) => {
		const { container } = setup(t);
		const data = result(
			type,
			type === "histogram"
				? [mark({ x: -2, y: 4, low: -2, high: 0 }), mark({ x: 0, y: 2, low: 0, high: 2 })]
				: type === "box"
					? [mark({ low: -2, q1: 0, median: 4, q3: 8, high: 12 })]
					: type === "scatter"
						? [mark({ x: 1, y: 2 }), mark({ x: 4, y: 5 })]
						: type === "missingness"
							? [mark({ x: "Source category", y: 2, value: 1 }), mark({ x: "Source amount", y: 2, value: 0 })]
							: [
									mark(),
									mark({ x: "B", y: type === "heatmap" || type === "correlation" ? "Row B" : 6, value: 6 }),
								],
		);
		renderChart(container, data, () => {});
		const root = container.querySelector("svg")!;
		assert.equal(root.getAttribute("data-chart-type"), type);
		assert.equal(container.querySelectorAll("[data-chart-mark]").length, data.marks.length);
		assert.match(container.querySelector('[data-chart-axis="x"]')?.textContent ?? "", /Source category/);
		assert.match(container.querySelector('[data-chart-axis="y"]')?.textContent ?? "", /Source amount/);
		assert.match(root.querySelector("desc")?.textContent ?? "", /100 observed rows; population 1000/);
		assert.match(root.querySelector("desc")?.textContent ?? "", /Source amount > 2/);
		assert.ok(root.getAttribute("aria-labelledby"));
		assert.ok(root.getAttribute("aria-describedby"));
		assert.equal(root.querySelectorAll("script, foreignObject, style, [style], [onclick]").length, 0);
		if (type === "box")
			for (const shape of ["box", "whiskers", "median"])
				assert.ok(container.querySelector(`[data-chart-shape="${shape}"]`));
		if (type === "histogram" || type === "bar") assert.ok(container.querySelector('[data-chart-shape="bar"]'));
		if (type === "line")
			assert.match(container.querySelector("[data-chart-line]")?.getAttribute("d") ?? "", /M .*L /);
		if (type === "scatter") assert.equal(container.querySelectorAll("[data-chart-mark] circle").length, 2);
		if (["heatmap", "correlation", "missingness"].includes(type))
			assert.equal(container.querySelectorAll('[data-chart-shape="cell"]').length, 2);
		for (const element of root.querySelectorAll("*"))
			for (const attribute of element.attributes)
				if (["x", "y", "cx", "cy", "width", "height", "d"].includes(attribute.name))
					assert.doesNotMatch(attribute.value, /NaN|Infinity/);
	});
}

test("mouse and keyboard selection share row IDs with roving chart focus", (t) => {
	const { container, browser } = setup(t);
	const selected: number[][] = [];
	const data = result("bar", [mark(), mark({ x: "B", rowIds: [9] })]);
	renderChart(container, data, (ids) => selected.push(ids));
	const buttons = container.querySelectorAll<SVGGElement>('[role="button"]');
	assert.equal(buttons[0].getAttribute("tabindex"), "0");
	assert.equal(buttons[1].getAttribute("tabindex"), "-1");
	buttons[0].dispatchEvent(new browser.MouseEvent("click", { bubbles: true }) as unknown as Event);
	assert.deepEqual(selected[0], [2, 5]);
	assert.notEqual(selected[0], data.marks[0].rowIds);
	assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
	buttons[0].dispatchEvent(new browser.KeyboardEvent("keydown", { key: " ", cancelable: true }) as unknown as Event);
	assert.deepEqual(selected[1], []);
	buttons[1].dispatchEvent(
		new browser.KeyboardEvent("keydown", { key: "Enter", cancelable: true }) as unknown as Event,
	);
	assert.deepEqual(selected[2], [9]);
	buttons[1].dispatchEvent(new browser.Event("focus") as unknown as Event);
	assert.equal(buttons[0].getAttribute("tabindex"), "-1");
	assert.equal(buttons[1].getAttribute("tabindex"), "0");
	assert.match(container.querySelector("figcaption")?.textContent ?? "", /1 linked rows/);
});

test("facet panels use shared domains and separate line series", (t) => {
	const { container } = setup(t);
	const data = result("line", [
		mark({ x: 1, y: 2, facet: "East", color: "One" }),
		mark({ x: 2, y: 4, facet: "East", color: "One" }),
		mark({ x: 1, y: 2, facet: "West", color: "One" }),
		mark({ x: 2, y: 20, facet: "West", color: "Two" }),
		mark({ x: 1, y: 2, facet: "North", color: "One" }),
		mark({ x: 1, y: 2, facet: "South", color: "One" }),
	]);
	data.spec.facet = 2;
	data.spec.color = 3;
	renderChart(container, data);
	const panels = container.querySelectorAll("[data-chart-panel]");
	assert.equal(panels.length, 4);
	const positions = [...panels].map((panel) => panel.querySelector("[data-chart-mark] circle")?.getAttribute("cy"));
	assert.ok(positions.every((position) => position === positions[0]));
	const paths = [...panels[1].querySelectorAll("[data-chart-line]")];
	assert.ok(
		paths.every((path) => !path.getAttribute("d")?.includes("L")),
		"different colors are not connected",
	);
	assert.match(container.querySelector('[data-chart-legend="color"]')?.textContent ?? "", /Source region/);
});

test("negative bars straddle zero and explicit minima are disclosed", (t) => {
	const { container } = setup(t);
	const data = result("bar", [mark({ y: -5 }), mark({ x: "B", y: 10 })]);
	renderChart(container, data);
	const baseline = Number(container.querySelector("[data-zero-baseline]")!.getAttribute("y1"));
	const bars = container.querySelectorAll('[data-chart-shape="bar"]');
	assert.equal(Number(bars[0].getAttribute("y")), baseline);
	assert.ok(Number(bars[1].getAttribute("y")) < baseline);
	data.spec.yMin = 5;
	data.warnings.push("Explicit Y minimum truncates the axis.");
	renderChart(container, data);
	assert.match(container.querySelector('[data-axis-warning="y"]')?.textContent ?? "", /Y starts 5/);
	assert.equal(container.querySelector("[data-zero-baseline]"), null);
});

test("constant scatter values remain finite and size has an area legend", (t) => {
	const { container } = setup(t);
	const data = result("scatter", [mark({ x: 7, y: 7, size: 4 }), mark({ x: 7, y: 7, size: 16 })]);
	data.spec.size = 2;
	data.spec.zeroBaseline = false;
	renderChart(container, data);
	const circles = container.querySelectorAll("[data-chart-mark] circle");
	assert.equal(Number(circles[0].getAttribute("r")), 6);
	assert.equal(Number(circles[1].getAttribute("r")), 12);
	assert.ok(Number.isFinite(Number(circles[0].getAttribute("cx"))));
	assert.match(
		container.querySelector('[data-chart-legend="size"]')?.textContent ?? "",
		/Source weight · circle area/,
	);
});

test("undefined correlations are hatched, distinct from genuine zero", (t) => {
	const { container } = setup(t);
	renderChart(
		container,
		result("correlation", [mark({ x: "A", y: "A", value: null }), mark({ x: "A", y: "B", value: 0 })]),
	);
	const cells = container.querySelectorAll('[data-chart-shape="cell"]');
	assert.match(cells[0].getAttribute("fill") ?? "", /unavailable/);
	assert.doesNotMatch(cells[1].getAttribute("fill") ?? "", /unavailable/);
	assert.match(container.querySelector("[data-chart-mark]")?.textContent ?? "", /Not available/);
});

test("date lines use elapsed time rather than equidistant categories", (t) => {
	const { container } = setup(t);
	const data = result("line", [
		mark({ x: "2026-01-01", y: 1 }),
		mark({ x: "2026-01-02", y: 2 }),
		mark({ x: "2026-01-11", y: 3 }),
	]);
	data.labels.x = "Recorded date (ISO date order)";
	renderChart(container, data);
	const xs = [...container.querySelectorAll("[data-chart-mark] circle")].map((node) =>
		Number(node.getAttribute("cx")),
	);
	assert.ok(Math.abs((xs[1] - xs[0]) / (xs[2] - xs[0]) - 0.1) < 1e-9);
});

test("empty and model states guide without fabricating marks", (t) => {
	const { container } = setup(t);
	renderChart(container, result("bar", []));
	assert.match(container.textContent ?? "", /No plottable values/);
	assert.match(container.textContent ?? "", /Try removing a filter/);
	assert.equal(container.querySelectorAll("[data-chart-mark]").length, 0);
	renderChart(container, result("model-result", []));
	assert.match(container.textContent ?? "", /not a fitted model/);
	assert.match(container.textContent ?? "", /No AI or Python is executed/);
});

test("untrusted labels are text in the canvas and standalone exports", async (t) => {
	const { container, browser, document } = setup(t);
	const label = '</script><img src="https://invalid.test/x" onerror="alert(1)"><svg onload="alert(2)">&';
	const data = result("bar", [mark({ x: label })]);
	data.labels.x = label;
	data.labels.filters = label;
	data.warnings = [label];
	renderChart(container, data);
	assert.equal(container.querySelector("script,img,[onerror],[onload],foreignObject"), null);
	assert.match(container.querySelector("[data-chart-mark]")?.getAttribute("aria-label") ?? "", /<\/script>/);
	const saved = Object.getOwnPropertyDescriptors(globalThis);
	Object.defineProperty(globalThis, "document", { value: document, configurable: true });
	Object.defineProperty(globalThis, "XMLSerializer", { value: browser.XMLSerializer, configurable: true });
	t.after(() => {
		for (const key of ["document", "XMLSerializer"]) {
			if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	const json = await exportChart(data, "json");
	assert.equal(json.extension, "json");
	assert.deepEqual(JSON.parse(await json.blob.text()), data);
	const exported = await exportChart(data, "svg");
	assert.equal(exported.extension, "svg");
	const source = await exported.blob.text();
	assert.match(source, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
	assert.doesNotMatch(source, /<img|<script|<foreignObject/);
	const parsed = new browser.DOMParser().parseFromString(source, "image/svg+xml");
	assert.equal(parsed.querySelector("parsererror"), null);
	assert.equal(parsed.querySelector("script,img,[onerror],[onload],foreignObject"), null);
	assert.deepEqual(JSON.parse(parsed.querySelector("metadata")!.textContent!), data);
	assert.match(parsed.querySelector("[data-export-notes]")?.textContent ?? "", /1000 population/);
	assert.equal(parsed.querySelectorAll("[data-chart-mark]").length, 1);
	const html = await exportChart(data, "html");
	const page = new browser.DOMParser().parseFromString(await html.blob.text(), "text/html");
	assert.equal(page.querySelector("script,img,[onerror],[onload],foreignObject"), null);
	assert.match(
		page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
		/default-src 'none'/,
	);
	assert.deepEqual(JSON.parse(page.querySelector("pre[data-chart-result]")!.textContent!), data);
	assert.ok(page.querySelector("svg [data-chart-mark]"));
});
