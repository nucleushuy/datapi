import type { ChartMark, ChartResult } from "../chart-contracts.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
// Existing workbench theme tokens, also used for detached export fallbacks.
const THEME = {
	"body-bg": "#18181e",
	"raised-bg": "#26262d",
	border: "#3b3b45",
	"border-muted": "#2c2c35",
	text: "#d4d4d4",
	"text-strong": "#eeeede",
	muted: "#aaa9b5",
	focus: "#c8d185",
	warning: "#f0c674",
	"chart-1": "#76b5de",
	"chart-2": "#f0bc62",
	"chart-3": "#72c8a6",
	"chart-4": "#d7a0c1",
	"chart-5": "#e58c70",
	"chart-6": "#d7d27b",
	"chart-7": "#a4b2e2",
	"chart-8": "#d5d8da",
	"font-sans": '"Avenir Next", "Segoe UI", sans-serif',
} as const;
const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, section: 48, axis: 72, labels: 96 };
const TYPE = { small: 11, body: 13, heading: 18 };
const DASHES = ["", "8 4", "2 4", "8 4 2 4", "12 4", "4 4", "12 4 2 4", "2 2", "8 2 2 2", "12 4 4 4"];
const NAMES = {
	histogram: "Histogram",
	box: "Box plot",
	bar: "Bar chart",
	line: "Line chart",
	scatter: "Scatter plot",
	heatmap: "Heatmap",
	correlation: "Correlation matrix",
	missingness: "Missingness matrix",
	"model-result": "Model results",
};
let sequence = 0;
type Attributes = Record<string, string | number>;
type Axis = {
	numeric: boolean;
	low: number;
	high: number;
	values: (string | number)[];
	position: (value: string | number) => number;
	step: number;
	date: boolean;
};
function short(value: string, length: number): string {
	return value.length > length ? `${value.slice(0, Math.max(1, length - 1))}…` : value;
}
const formatter = new Intl.NumberFormat("en", { maximumSignificantDigits: 4 });
function number(value: number): string {
	if (!Number.isFinite(value)) return "Not available";
	return value !== 0 && (Math.abs(value) >= 1e7 || Math.abs(value) < 0.001)
		? value.toExponential(2)
		: formatter.format(value);
}
function titleFor(result: ChartResult): string {
	const fields = [result.labels.x, result.labels.y].filter(Boolean).join(" × ");
	return `${NAMES[result.spec.type]}${fields ? ` · ${fields}` : ""}`;
}
function descriptionFor(result: ChartResult): string {
	return [
		`${result.marks.length} marks. ${result.filteredRows} filtered rows from ${result.sampleSize} observed rows; population ${result.populationRows}.`,
		`${result.sampled ? "Systematic sample; not extrapolated" : "Full bounded scan"}; stride ${result.stride}; byte limit ${result.byteLimited ? "reached" : "not reached"}.`,
		`Aggregation: ${result.labels.aggregation || result.spec.aggregation}. Filters: ${result.labels.filters || "None"}.`,
		`Missing values: ${result.labels.missing || "Not specified"}. Excluded rows: ${result.excludedRows}. Omitted marks: ${result.omittedMarks}.`,
		`Dataset version: ${result.spec.datasetVersionId}. SHA-256: ${result.datasetVersionHash}. Generated: ${result.generatedAt}.`,
		...result.warnings.map((warning) => `Warning: ${warning}`),
	].join(" ");
}
function valueDescription(result: ChartResult, mark: ChartMark): string {
	const values = [`${result.labels.x || "X"}: ${mark.x}`, `${result.labels.y || "Y"}: ${mark.y}`];
	if (result.spec.type === "histogram") values.push(`Bin: ${mark.low} to ${mark.high}`, `Count: ${mark.value}`);
	if (result.spec.type === "box")
		values.push(
			`Lower whisker: ${mark.low}`,
			`Q1: ${mark.q1}`,
			`Median: ${mark.median}`,
			`Q3: ${mark.q3}`,
			`Upper whisker: ${mark.high}`,
		);
	if (result.spec.type === "missingness")
		values.push(mark.value === 1 ? "Missing (SQL NULL)" : "Present (including empty strings)");
	else if (["heatmap", "correlation"].includes(result.spec.type))
		values.push(`Value: ${mark.value === null ? "Not available" : mark.value}`);
	if (mark.color !== null) values.push(`${result.labels.color || "Color"}: ${mark.color}`);
	if (mark.size !== null) values.push(`${result.labels.size || "Size"}: ${mark.size}`);
	if (mark.facet !== null) values.push(`${result.labels.facet || "Facet"}: ${mark.facet}`);
	values.push(`${mark.rowIds.length} linked rows`);
	return values.join(". ");
}
function numericAxis(
	values: number[],
	start: number,
	end: number,
	minimum: number | null,
	zero: boolean,
	date = false,
): Axis {
	let low = values.length ? Math.min(...values) : 0;
	let high = values.length ? Math.max(...values) : 1;
	if (zero) {
		low = Math.min(0, low);
		high = Math.max(0, high);
	}
	if (minimum !== null) low = minimum;
	if (high <= low) {
		const extension = Math.max(1, Math.abs(low) * 0.1);
		high = Math.min(Number.MAX_VALUE, low + extension);
		if (high === low) low -= extension;
	} else if (!date) {
		const padding = high / 20 - low / 20;
		high = Math.min(Number.MAX_VALUE, high + padding);
		if (minimum === null && !zero) low = Math.max(-Number.MAX_VALUE, low - padding);
	}
	const magnitude = Math.max(Math.abs(low), Math.abs(high), 1);
	const scaledLow = low / magnitude;
	const span = high / magnitude - scaledLow;
	return {
		numeric: true,
		low,
		high,
		values: [],
		step: 0,
		date,
		position: (value) => {
			const numeric = date && typeof value === "string" ? Date.parse(value) : Number(value);
			return start + ((numeric / magnitude - scaledLow) / span) * (end - start);
		},
	};
}
function categoricalAxis(values: (string | number)[], start: number, end: number): Axis {
	const unique = [...new Set(values)];
	const index = new Map(unique.map((value, position) => [value, position]));
	const step = (end - start) / Math.max(1, unique.length);
	return {
		numeric: false,
		low: 0,
		high: unique.length,
		values: unique,
		step: Math.abs(step),
		date: false,
		position: (value) => start + ((index.get(value) ?? 0) + 0.5) * step,
	};
}
function ticks(axis: Axis, maximum: number): { value: string | number; label: string }[] {
	if (!axis.numeric) {
		const stride = Math.max(1, Math.ceil(axis.values.length / maximum));
		return axis.values
			.filter((_, index) => index % stride === 0 || index === axis.values.length - 1)
			.map((value) => ({ value, label: String(value) }));
	}
	return Array.from({ length: 5 }, (_, index) => {
		const fraction = index / 4;
		const value = axis.low * (1 - fraction) + axis.high * fraction;
		const iso = axis.date ? new Date(value).toISOString() : "";
		return {
			value: axis.date ? iso : value,
			label: axis.date ? iso.slice(0, axis.high - axis.low < 86_400_000 ? 16 : 10).replace("T", " ") : number(value),
		};
	});
}

/** Render bounded analytical marks without reaggregating source rows. */
export function renderChart(container: HTMLElement, result: ChartResult, onSelect?: (ids: number[]) => void): void {
	const document = container.ownerDocument;
	const theme = document.defaultView?.getComputedStyle(document.documentElement);
	const tokens = new Map(
		Object.entries(THEME).map(([token, fallback]) => [
			token,
			theme?.getPropertyValue(`--${token}`).trim() || fallback,
		]),
	);
	const color = (token: string) => tokens.get(token) ?? tokens.get("text")!;
	const palette = (index: number) => color(`chart-${(index % 8) + 1}`);
	function svg<K extends keyof SVGElementTagNameMap>(
		tag: K,
		attrs: Attributes = {},
		content?: string,
	): SVGElementTagNameMap[K] {
		const node = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
		if (content !== undefined) node.textContent = content;
		return node;
	}
	function text(parent: SVGElement, value: string, x: number, y: number, attrs: Attributes = {}): SVGTextElement {
		const node = svg("text", { x, y, fill: color("text"), "font-size": TYPE.body, ...attrs }, value);
		parent.append(node);
		return node;
	}
	function point(parent: SVGElement, x: number, y: number, radius: number, index: number): void {
		parent.append(
			svg("circle", {
				cx: x,
				cy: y,
				r: radius,
				fill: palette(index),
				stroke: color("body-bg"),
				"stroke-width": 1,
				class: "chart-glyph",
			}),
		);
		if (index === 0) return;
		const r = Math.min(radius * 0.65, SPACE.xs);
		let d: string;
		switch (index % 5) {
			case 1:
				d = `M ${x - r} ${y - r} H ${x + r} V ${y + r} H ${x - r} Z`;
				break;
			case 2:
				d = `M ${x} ${y - r} L ${x + r} ${y + r} H ${x - r} Z`;
				break;
			case 3:
				d = `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`;
				break;
			case 4:
				d = `M ${x - r} ${y} H ${x + r} M ${x} ${y - r} V ${y + r}`;
				break;
			default:
				d = `M ${x - r} ${y - r} L ${x + r} ${y + r} M ${x + r} ${y - r} L ${x - r} ${y + r}`;
		}
		parent.append(
			svg("path", {
				d,
				fill: index > 5 ? color("body-bg") : "none",
				stroke: color("body-bg"),
				"stroke-width": 1.5,
				"pointer-events": "none",
			}),
		);
	}
	const id = `workbench-chart-${++sequence}`;
	const width = Math.max(360, Math.min(960, container.clientWidth || 720));
	const matrix = ["heatmap", "correlation", "missingness"].includes(result.spec.type);
	const facets = [...new Set(result.marks.map((mark) => mark.facet))];
	if (!facets.length) facets.push(null);
	const columns = facets.length > 1 && width >= 720 ? 2 : 1;
	const panelWidth = width / columns;
	const matrixRows = matrix ? new Set(result.marks.map((mark) => mark.y)).size : 0;
	const panelHeight = Math.max(384, Math.min(768, matrixRows * SPACE.lg + SPACE.labels + SPACE.section));
	const colors = [...new Set(result.marks.map((mark) => mark.color))];
	const colorIndex = new Map(colors.map((value, index) => [value, index]));
	const hasColor = result.spec.color !== null && colors.some((value) => value !== null);
	const hasSize = result.spec.type === "scatter" && result.spec.size !== null;
	const legendColumns = Math.max(1, Math.floor(width / 240));
	const legendRows =
		Math.ceil((hasColor && !matrix ? colors.length : 0) / legendColumns) + (hasSize ? 3 : 0) + (matrix ? 3 : 0);
	const top = SPACE.section;
	const height =
		top +
		Math.ceil(facets.length / columns) * panelHeight +
		(legendRows ? SPACE.xl + legendRows * SPACE.xl : 0) +
		SPACE.lg;
	const figure = document.createElement("figure");
	figure.className = "chart-figure";
	const root = svg("svg", {
		xmlns: SVG_NS,
		viewBox: `0 0 ${width} ${height}`,
		width,
		height,
		role: onSelect ? "group" : "img",
		"aria-labelledby": `${id}-title`,
		"aria-describedby": `${id}-desc`,
		class: "workbench-chart",
		"data-chart-type": result.spec.type,
		"font-family": color("font-sans"),
	});
	root.append(
		svg("title", { id: `${id}-title` }, titleFor(result)),
		svg("desc", { id: `${id}-desc` }, descriptionFor(result)),
	);
	root.append(svg("rect", { width, height, fill: color("body-bg"), "data-chart-background": "true" }));
	text(root, short(titleFor(result), Math.floor((width - SPACE.xxl) / 9)), SPACE.lg, SPACE.xl, {
		"font-size": TYPE.heading,
		"font-weight": 600,
	}).append(svg("title", {}, titleFor(result)));
	const defs = svg("defs");
	for (let index = 0; index < Math.max(1, colors.length); index++) {
		const pattern = svg("pattern", {
			id: `${id}-pattern-${index}`,
			width: SPACE.sm,
			height: SPACE.sm,
			patternUnits: "userSpaceOnUse",
			patternTransform: `rotate(${(index % 4) * 45})`,
		});
		pattern.append(svg("rect", { width: SPACE.sm, height: SPACE.sm, fill: palette(index) }));
		if (index > 0)
			pattern.append(
				index < 5
					? svg("path", {
							d: "M 0 0 V 8",
							stroke: color("body-bg"),
							"stroke-width": index === 4 ? 3 : 2,
							opacity: 0.6,
						})
					: svg("circle", {
							cx: SPACE.xs,
							cy: SPACE.xs,
							r: index < 8 ? 1 : 2,
							fill: color("body-bg"),
							opacity: 0.75,
						}),
			);
		defs.append(pattern);
	}
	const unavailable = svg("pattern", {
		id: `${id}-unavailable`,
		width: SPACE.sm,
		height: SPACE.sm,
		patternUnits: "userSpaceOnUse",
	});
	unavailable.append(
		svg("rect", { width: SPACE.sm, height: SPACE.sm, fill: color("raised-bg") }),
		svg("path", { d: "M 0 8 L 8 0", stroke: color("muted"), "stroke-width": 1 }),
	);
	defs.append(unavailable);
	root.append(defs);
	const status = document.createElement("figcaption");
	status.setAttribute("aria-live", "polite");
	status.textContent =
		onSelect && result.marks.some((mark) => mark.rowIds.length)
			? "Select a mark to highlight its source rows. Tab into the chart; use arrow keys, then Enter or Space. Select again to clear."
			: `${result.marks.length} plotted marks. Hover a mark for its values.`;
	const interactive: SVGGElement[] = [];
	let selected: SVGGElement | null = null;
	function markGroup(mark: ChartMark): SVGGElement {
		const description = valueDescription(result, mark);
		const group = svg("g", { class: "chart-mark", "data-chart-mark": result.spec.type, "aria-label": description });
		group.append(svg("title", {}, description));
		if (onSelect && mark.rowIds.length) {
			group.setAttribute("role", "button");
			group.setAttribute("tabindex", interactive.length ? "-1" : "0");
			group.setAttribute("aria-pressed", "false");
			const select = () => {
				const clear = selected === group;
				selected?.setAttribute("aria-pressed", "false");
				selected = clear ? null : group;
				group.setAttribute("aria-pressed", String(!clear));
				status.textContent = clear ? "Selection cleared. All source rows are shown." : `${description}. Selected.`;
				onSelect(clear ? [] : [...mark.rowIds]);
			};
			group.addEventListener("click", select);
			group.addEventListener("focus", () => {
				for (const other of interactive) other.setAttribute("tabindex", other === group ? "0" : "-1");
				status.textContent = description;
			});
			group.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					select();
				} else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) {
					event.preventDefault();
					const current = interactive.indexOf(group);
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? interactive.length - 1
								: (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + interactive.length) %
									interactive.length;
					interactive[next]?.focus();
				}
			});
			interactive.push(group);
		}
		return group;
	}
	const maxSize = Math.max(0, ...result.marks.map((mark) => mark.size ?? 0));
	const radius = (value: number | null) =>
		value === null || !hasSize ? SPACE.xs : Math.max(2, Math.sqrt(Math.max(0, value) / (maxSize || 1)) * SPACE.md);
	const numericValues = result.marks.flatMap((mark) => (mark.value === null ? [] : [mark.value]));
	const valueLow = result.spec.type === "correlation" ? -1 : Math.min(0, ...numericValues);
	const valueHigh =
		result.spec.type === "correlation" || result.spec.type === "missingness" ? 1 : Math.max(0, ...numericValues);
	function cellFill(value: number | null): { fill: string; opacity: number } {
		if (value === null) return { fill: `url(#${id}-unavailable)`, opacity: 1 };
		if (result.spec.type === "missingness")
			return { fill: value === 1 ? `url(#${id}-unavailable)` : color("chart-3"), opacity: value === 1 ? 1 : 0.35 };
		const extent = Math.max(Math.abs(valueLow), Math.abs(valueHigh));
		return {
			fill: color(value < 0 ? "chart-2" : "chart-1"),
			opacity: extent ? 0.12 + (0.88 * Math.abs(value)) / extent : 0.12,
		};
	}
	if (result.spec.type === "model-result" || !result.marks.length) {
		const model = result.spec.type === "model-result";
		text(root, model ? "No model has been run" : "No plottable values", SPACE.xxl, top + SPACE.section, {
			"font-size": TYPE.heading,
			"font-weight": 600,
		});
		const guidance = model
			? [
					"This is a placeholder, not a fitted model.",
					"Choose a deterministic chart to explore the dataset.",
					"No AI or Python is executed.",
				]
			: ["Review fields, filters, and missing-value handling.", "Try removing a filter or choosing another field."];
		guidance.forEach((line, index) => {
			text(root, line, SPACE.xxl, top + SPACE.section + SPACE.xxl + index * SPACE.xl, {
				"font-size": TYPE.small,
				fill: color("muted"),
			});
		});
		status.textContent = guidance.join(" ");
	} else {
		// Shared domains make values comparable between all facet panels.
		const left = SPACE.axis;
		const right = panelWidth - SPACE.xl;
		const plotTop = SPACE.xxl;
		const bottom = panelHeight - SPACE.labels;
		const lineDate = result.spec.type === "line" && result.labels.x.includes("(ISO date order)");
		const xNumeric =
			!matrix &&
			(result.spec.type === "histogram" ||
				result.spec.type === "scatter" ||
				(result.spec.type === "line" && (lineDate || result.marks.every((mark) => typeof mark.x === "number"))));
		const xValues = result.marks
			.flatMap((mark) =>
				result.spec.type === "histogram"
					? [mark.low ?? Number(mark.x), mark.high ?? Number(mark.x)]
					: [lineDate ? Date.parse(String(mark.x)) : Number(mark.x)],
			)
			.filter(Number.isFinite);
		const yValues = result.marks
			.flatMap((mark) =>
				result.spec.type === "box" ? [mark.low ?? Number(mark.y), mark.high ?? Number(mark.y)] : [Number(mark.y)],
			)
			.filter(Number.isFinite);
		const xAxis = xNumeric
			? numericAxis(
					xValues,
					left,
					right,
					result.spec.xMin,
					result.spec.type === "scatter" && result.spec.zeroBaseline,
					lineDate,
				)
			: categoricalAxis(
					result.marks.map((mark) => mark.x),
					left,
					right,
				);
		const yAxis = matrix
			? categoricalAxis(
					result.marks.map((mark) => mark.y),
					plotTop,
					bottom,
				)
			: numericAxis(yValues, bottom, plotTop, result.spec.yMin, result.spec.zeroBaseline);
		const plotWidth = right - left;
		const plotHeight = bottom - plotTop;
		facets.forEach((facet, facetIndex) => {
			const panel = svg("g", {
				transform: `translate(${(facetIndex % columns) * panelWidth} ${top + Math.floor(facetIndex / columns) * panelHeight})`,
				"data-chart-panel": facet ?? "all",
			});
			root.append(panel);
			if (facet !== null)
				text(
					panel,
					short(`${result.labels.facet || "Facet"}: ${facet}`, Math.floor((panelWidth - SPACE.xxl) / 7)),
					SPACE.lg,
					SPACE.md,
					{ "font-weight": 600 },
				).append(svg("title", {}, `${result.labels.facet}: ${facet}`));
			const clipId = `${id}-clip-${facetIndex}`;
			const clip = svg("clipPath", { id: clipId });
			clip.append(svg("rect", { x: left, y: plotTop, width: plotWidth, height: plotHeight }));
			defs.append(clip);
			for (const tick of ticks(xAxis, Math.max(3, Math.floor(plotWidth / SPACE.section)))) {
				const x = xAxis.position(tick.value);
				panel.append(svg("line", { x1: x, x2: x, y1: bottom, y2: bottom + SPACE.xs, stroke: color("border") }));
				text(panel, short(tick.label, xAxis.numeric && !xAxis.date ? 12 : 20), x, bottom + SPACE.lg, {
					class: "chart-tick",
					fill: color("muted"),
					"font-size": TYPE.small,
					"text-anchor": xAxis.numeric && !xAxis.date ? "middle" : "end",
					transform: xAxis.numeric && !xAxis.date ? "" : `rotate(-40 ${x} ${bottom + SPACE.lg})`,
				}).append(svg("title", {}, tick.label));
			}
			for (const tick of ticks(yAxis, Math.max(4, Math.floor(plotHeight / SPACE.xl)))) {
				const y = yAxis.position(tick.value);
				if (!matrix)
					panel.append(svg("line", { x1: left, x2: right, y1: y, y2: y, stroke: color("border-muted") }));
				text(panel, short(tick.label, 10), left - SPACE.sm, y + SPACE.xs, {
					class: "chart-tick",
					fill: color("muted"),
					"font-size": TYPE.small,
					"text-anchor": "end",
				}).append(svg("title", {}, tick.label));
			}
			panel.append(
				svg("path", { d: `M ${left} ${plotTop} V ${bottom} H ${right}`, fill: "none", stroke: color("border") }),
			);
			text(
				panel,
				short(result.labels.x || "X", Math.floor(plotWidth / 7)),
				(left + right) / 2,
				panelHeight - SPACE.sm,
				{ fill: color("text-strong"), "data-chart-axis": "x", "text-anchor": "middle" },
			).append(svg("title", {}, result.labels.x));
			const yMiddle = (plotTop + bottom) / 2;
			text(panel, short(result.labels.y || "Y", Math.floor(plotHeight / 7)), SPACE.lg, yMiddle, {
				fill: color("text-strong"),
				"data-chart-axis": "y",
				"text-anchor": "middle",
				transform: `rotate(-90 ${SPACE.lg} ${yMiddle})`,
			}).append(svg("title", {}, result.labels.y));
			if (yAxis.numeric && yAxis.low <= 0 && yAxis.high >= 0)
				panel.append(
					svg("line", {
						x1: left,
						x2: right,
						y1: yAxis.position(0),
						y2: yAxis.position(0),
						stroke: color("muted"),
						"stroke-dasharray": "4 4",
						"data-zero-baseline": "true",
					}),
				);
			if (yAxis.numeric && (yAxis.low > 0 || yAxis.high < 0))
				text(panel, `Y starts ${number(yAxis.low)} · zero outside view`, left, plotTop - SPACE.sm, {
					fill: color("warning"),
					"font-size": TYPE.small,
					"data-axis-warning": "y",
				});
			else if (xNumeric && result.spec.xMin !== null)
				text(panel, `X starts at ${number(result.spec.xMin)}`, left, plotTop - SPACE.sm, {
					fill: color("warning"),
					"font-size": TYPE.small,
					"data-axis-warning": "x",
				});
			const plot = svg("g", { "clip-path": `url(#${clipId})` });
			panel.append(plot);
			const marks = result.marks.filter((mark) => mark.facet === facet);
			if (result.spec.type === "line") {
				for (const value of colors) {
					const series = marks.filter((mark) => mark.color === value);
					const index = colorIndex.get(value) ?? 0;
					plot.append(
						svg("path", {
							d: series
								.map(
									(mark, index) => `${index ? "L" : "M"} ${xAxis.position(mark.x)} ${yAxis.position(mark.y)}`,
								)
								.join(" "),
							fill: "none",
							stroke: palette(index),
							"stroke-width": 2,
							"stroke-dasharray": DASHES[index % DASHES.length] ?? "",
							"data-chart-line": "true",
						}),
					);
				}
			}
			for (const mark of marks) {
				const group = markGroup(mark);
				const index = colorIndex.get(mark.color) ?? 0;
				const x = xAxis.position(mark.x);
				const y = yAxis.position(mark.y);
				const fill = `url(#${id}-pattern-${index})`;
				if (result.spec.type === "bar" || result.spec.type === "histogram") {
					const binLeft =
						result.spec.type === "histogram" ? xAxis.position(mark.low ?? mark.x) : x - xAxis.step * 0.4;
					const totalWidth =
						result.spec.type === "histogram"
							? Math.max(1, xAxis.position(mark.high ?? mark.x) - binLeft)
							: xAxis.step * 0.8;
					const barWidth = totalWidth / Math.max(1, colors.length);
					const zero = yAxis.position(Math.max(yAxis.low, Math.min(yAxis.high, 0)));
					group.append(
						svg("rect", {
							x: binLeft + index * barWidth,
							y: Math.min(y, zero),
							width: Math.max(0.5, barWidth - 1),
							height: Math.max(1, Math.abs(zero - y)),
							fill,
							class: "chart-glyph",
							"data-chart-shape": "bar",
						}),
					);
				} else if (result.spec.type === "box") {
					const band = (xAxis.step * 0.8) / Math.max(1, colors.length);
					const center = x - xAxis.step * 0.4 + band * (index + 0.5);
					const half = Math.min(SPACE.xl, band * 0.35);
					const low = yAxis.position(mark.low ?? mark.y);
					const high = yAxis.position(mark.high ?? mark.y);
					const q1 = yAxis.position(mark.q1 ?? mark.y);
					const q3 = yAxis.position(mark.q3 ?? mark.y);
					const median = yAxis.position(mark.median ?? mark.y);
					group.append(
						svg("path", {
							d: `M ${center} ${low} V ${high} M ${center - half} ${low} H ${center + half} M ${center - half} ${high} H ${center + half}`,
							stroke: palette(index),
							"stroke-width": 2,
							fill: "none",
							class: "chart-glyph",
							"data-chart-shape": "whiskers",
						}),
						svg("rect", {
							x: center - half,
							y: Math.min(q1, q3),
							width: half * 2,
							height: Math.max(1, Math.abs(q1 - q3)),
							fill,
							stroke: palette(index),
							class: "chart-glyph",
							"data-chart-shape": "box",
						}),
						svg("line", {
							x1: center - half,
							x2: center + half,
							y1: median,
							y2: median,
							stroke: color("body-bg"),
							"stroke-width": 3,
							"data-chart-shape": "median",
						}),
					);
				} else if (matrix) {
					const cell = cellFill(mark.value);
					group.append(
						svg("rect", {
							x: x - xAxis.step / 2,
							y: y - yAxis.step / 2,
							width: xAxis.step - Math.min(1, xAxis.step * 0.15),
							height: yAxis.step - Math.min(1, yAxis.step * 0.15),
							fill: cell.fill,
							"fill-opacity": cell.opacity,
							class: "chart-glyph",
							"data-chart-shape": "cell",
						}),
					);
					if (result.spec.type !== "missingness" && xAxis.step >= SPACE.xxl && yAxis.step >= SPACE.xl)
						text(group, mark.value === null ? "N/A" : number(mark.value), x, y + SPACE.xs, {
							"text-anchor": "middle",
							"font-size": TYPE.small,
							fill: color("text-strong"),
							stroke: color("body-bg"),
							"stroke-width": 3,
							"paint-order": "stroke",
							"pointer-events": "none",
						});
				} else point(group, x, y, radius(mark.size), index);
				plot.append(group);
			}
		});
	}
	let legendY = top + Math.ceil(facets.length / columns) * panelHeight + SPACE.lg;
	if (matrix && result.marks.length) {
		const legend = svg("g", { "data-chart-legend": "value" });
		root.append(legend);
		if (result.spec.type === "missingness") {
			legend.append(
				svg("rect", {
					x: SPACE.lg,
					y: legendY - SPACE.md,
					width: SPACE.md,
					height: SPACE.md,
					fill: color("chart-3"),
					"fill-opacity": 0.35,
				}),
				svg("rect", {
					x: SPACE.lg,
					y: legendY + SPACE.md,
					width: SPACE.md,
					height: SPACE.md,
					fill: `url(#${id}-unavailable)`,
				}),
			);
			text(legend, "Present (including empty strings)", SPACE.xxl, legendY, { "font-size": TYPE.small });
			text(legend, "Missing (SQL NULL)", SPACE.xxl, legendY + SPACE.xl, { "font-size": TYPE.small });
		} else {
			const label =
				result.spec.type === "correlation"
					? "Pearson r · amber negative / blue positive"
					: `${result.labels.aggregation || "Value"}${result.labels.size ? ` · ${result.labels.size}` : ""}`;
			text(legend, short(label, Math.floor((width - SPACE.xxl) / 7)), SPACE.lg, legendY, {
				"font-size": TYPE.small,
			}).append(svg("title", {}, label));
			for (let index = 0; index < 5; index++) {
				const value = valueLow * (1 - index / 4) + (valueHigh * index) / 4;
				const cell = cellFill(value);
				const x = SPACE.lg + (index * (width - SPACE.xxl)) / 5;
				legend.append(
					svg("rect", {
						x,
						y: legendY + SPACE.md,
						width: SPACE.lg,
						height: SPACE.md,
						fill: cell.fill,
						"fill-opacity": cell.opacity,
					}),
				);
				text(legend, number(value), x + SPACE.xl, legendY + SPACE.xl, { "font-size": TYPE.small });
			}
			text(legend, "Hatched: unavailable, not zero. Focus/hover for values.", SPACE.lg, legendY + SPACE.section, {
				"font-size": TYPE.small,
				fill: color("muted"),
			});
		}
		legendY += SPACE.section;
	} else if (hasColor) {
		const legend = svg("g", { "data-chart-legend": "color" });
		root.append(legend);
		colors.forEach((value, index) => {
			const x = SPACE.lg + ((index % legendColumns) * width) / legendColumns;
			const y = legendY + Math.floor(index / legendColumns) * SPACE.xl;
			if (["scatter", "line"].includes(result.spec.type)) point(legend, x + SPACE.sm, y - SPACE.xs, SPACE.sm, index);
			else
				legend.append(
					svg("rect", {
						x,
						y: y - SPACE.md,
						width: SPACE.lg,
						height: SPACE.lg,
						fill: `url(#${id}-pattern-${index})`,
					}),
				);
			const label = `${result.labels.color || "Color"}: ${value ?? "Not assigned"}`;
			text(legend, short(label, Math.floor((width / legendColumns - SPACE.section) / 7)), x + SPACE.xl, y, {
				"font-size": TYPE.small,
			}).append(svg("title", {}, label));
		});
		legendY += Math.ceil(colors.length / legendColumns) * SPACE.xl;
	}
	if (hasSize && result.marks.length) {
		const legend = svg("g", { "data-chart-legend": "size" });
		root.append(legend);
		const label = `${result.labels.size || "Size"} · circle area`;
		text(legend, short(label, Math.floor((width - SPACE.xxl) / 7)), SPACE.lg, legendY, {
			"font-size": TYPE.small,
		}).append(svg("title", {}, label));
		for (let index = 0; index < 3; index++) {
			const value = (maxSize * index) / 2;
			const x = SPACE.xxl + (index * (width - SPACE.section)) / 3;
			point(legend, x, legendY + SPACE.xl, radius(value), 0);
			text(legend, number(value), x + SPACE.lg, legendY + SPACE.xl + SPACE.xs, { "font-size": TYPE.small });
		}
		text(legend, "Zero/negative: minimum size; missing: standard point.", SPACE.lg, legendY + SPACE.section, {
			"font-size": TYPE.small,
			fill: color("muted"),
		});
	}
	figure.append(root, status);
	container.replaceChildren(figure);
}
