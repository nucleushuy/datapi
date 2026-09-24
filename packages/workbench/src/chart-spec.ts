import {
	CHART_MAX_CATEGORIES,
	CHART_TYPES,
	CHART_VERSION,
	type ChartFilter,
	type ChartRecommendation,
	type ChartResult,
	type ChartSpec,
} from "./chart-contracts.ts";
import type { DatasetColumn } from "./contracts.ts";
import type { ColumnProfile, DatasetProfile, SemanticType } from "./profile-contracts.ts";
import { finiteNumber } from "./profiler.ts";

const SPEC_KEYS = [
	"version",
	"datasetVersionId",
	"type",
	"x",
	"y",
	"color",
	"size",
	"facet",
	"aggregation",
	"sort",
	"filters",
	"bins",
	"categoryLimit",
	"zeroBaseline",
	"xMin",
	"yMin",
] as const;
const FILTER_KEYS = ["column", "op", "value"] as const;
const FILTER_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "is-null", "not-null"] as const;

function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function requireSpec(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function defaultChartSpec(datasetVersionId: string): ChartSpec {
	return {
		version: CHART_VERSION,
		datasetVersionId,
		type: "bar",
		x: null,
		y: null,
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
	};
}

/** Reject rather than discard unsupported controls, including additional/dual axes. */
export function parseChartSpec(value: unknown, schema: DatasetColumn[], versionId: string): ChartSpec {
	requireSpec(
		objectWithKeys(value, SPEC_KEYS),
		"Chart specification contains missing or unsupported options; dual axes are not supported.",
	);
	requireSpec(value.version === CHART_VERSION, "Unsupported chart specification version.");
	requireSpec(
		typeof value.datasetVersionId === "string" &&
			value.datasetVersionId === versionId &&
			/^[a-zA-Z0-9_-]{1,80}$/u.test(versionId),
		"Chart specification does not match the current dataset version.",
	);
	requireSpec(
		typeof value.type === "string" && CHART_TYPES.some((type) => type === value.type),
		"Unsupported chart type.",
	);
	requireSpec(
		typeof value.aggregation === "string" && ["count", "sum", "mean", "median", "none"].includes(value.aggregation),
		"Unsupported chart aggregation.",
	);
	requireSpec(
		typeof value.sort === "string" && ["ascending", "descending", "value-descending"].includes(value.sort),
		"Unsupported chart sort order.",
	);
	requireSpec(
		typeof value.bins === "number" && Number.isInteger(value.bins) && value.bins >= 5 && value.bins <= 100,
		"Histogram bins must be an integer from 5 to 100.",
	);
	requireSpec(
		typeof value.categoryLimit === "number" &&
			Number.isInteger(value.categoryLimit) &&
			value.categoryLimit >= 1 &&
			value.categoryLimit <= CHART_MAX_CATEGORIES,
		"Category limit must be an integer from 1 to 30.",
	);
	requireSpec(typeof value.zeroBaseline === "boolean", "Zero baseline must be a boolean.");
	for (const key of ["xMin", "yMin"] as const)
		requireSpec(
			value[key] === null || (typeof value[key] === "number" && Number.isFinite(value[key])),
			"Axis minima must be finite numbers or null.",
		);
	const columns = new Map(schema.map((column) => [column.index, column]));
	const columnAt = (index: unknown): DatasetColumn => {
		requireSpec(
			typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && columns.has(index),
			"Chart field does not exist in the current dataset schema.",
		);
		return columns.get(index)!;
	};
	for (const key of ["x", "y", "color", "size", "facet"] as const) {
		if (value[key] === null) continue;
		const column = columnAt(value[key]);
		requireSpec(
			column.basicType !== "binary" && column.basicType !== "nested",
			"Chart encodings require scalar fields, not binary or nested values.",
		);
	}
	requireSpec(Array.isArray(value.filters) && value.filters.length <= 8, "Charts support at most 8 filters.");
	const filters: ChartFilter[] = value.filters.map((filter: unknown) => {
		requireSpec(objectWithKeys(filter, FILTER_KEYS), "Chart filter contains missing or unsupported options.");
		const column = columnAt(filter.column);
		requireSpec(
			typeof filter.op === "string" && FILTER_OPS.some((op) => op === filter.op),
			"Unsupported chart filter operator.",
		);
		requireSpec(
			typeof filter.value === "string" && filter.value.length <= 512,
			"Chart filter values must be strings of at most 512 characters.",
		);
		if (filter.op === "is-null" || filter.op === "not-null") {
			requireSpec(filter.value === "", "Null filters do not accept a comparison value.");
		} else {
			requireSpec(
				column.basicType !== "binary" && column.basicType !== "nested",
				"Value filters require scalar fields.",
			);
			if (["gt", "gte", "lt", "lte"].includes(filter.op)) {
				const number = finiteNumber(filter.value);
				requireSpec(
					(column.basicType === "number" || column.basicType === "text") &&
						number !== null &&
						(!Number.isInteger(number) || Number.isSafeInteger(number)) &&
						(number !== 0 || !/[1-9]/u.test(filter.value.split(/[eE]/u)[0])),
					"Ordered filters require a safely representable finite numeric comparison and a numeric or text field.",
				);
			}
		}
		return { column: column.index, op: filter.op as ChartFilter["op"], value: filter.value };
	});
	const spec = { ...value, filters } as unknown as ChartSpec;
	const numeric = (index: number | null): boolean =>
		index !== null && ["number", "text"].includes(columnAt(index).basicType);
	const matrix = spec.type === "correlation" || spec.type === "missingness" || spec.type === "model-result";
	if (matrix) {
		requireSpec(
			[spec.x, spec.y, spec.color, spec.size, spec.facet].every((field) => field === null),
			"Matrix and model-result charts choose their fields automatically and do not support encodings.",
		);
		requireSpec(spec.aggregation === "none", "Matrix and model-result charts require no aggregation.");
		requireSpec(
			spec.xMin === null && spec.yMin === null && spec.zeroBaseline,
			"Matrix and model-result charts do not support numeric axis controls.",
		);
	} else {
		if (spec.type !== "scatter" && spec.type !== "heatmap")
			requireSpec(spec.size === null, "Size is supported only for scatter points or as the heatmap measure.");
		switch (spec.type) {
			case "histogram":
				requireSpec(
					numeric(spec.x) && spec.y === null && spec.aggregation === "count",
					"Histograms require numeric X, no Y, and count aggregation.",
				);
				break;
			case "box":
				requireSpec(
					numeric(spec.y) && spec.aggregation === "none",
					"Box plots require numeric Y and no aggregation; X optionally groups observations.",
				);
				break;
			case "bar":
			case "line":
				requireSpec(spec.type !== "line" || spec.x !== null, "Line charts require an X field.");
				requireSpec(
					spec.aggregation === "count" ? spec.y === null : numeric(spec.y),
					"Count charts require no Y; other aggregations require numeric Y.",
				);
				break;
			case "scatter":
				requireSpec(
					numeric(spec.x) &&
						numeric(spec.y) &&
						spec.aggregation === "none" &&
						(spec.size === null || numeric(spec.size)),
					"Scatter plots require numeric X and Y, no aggregation, and an optional numeric size field.",
				);
				break;
			case "heatmap":
				requireSpec(
					spec.x !== null && spec.y !== null && spec.color === null,
					"Heatmaps require X and Y categories and use the cell value, not another field, for color.",
				);
				requireSpec(
					spec.aggregation === "count"
						? spec.size === null
						: ["sum", "mean", "median"].includes(spec.aggregation) && numeric(spec.size),
					"Heatmaps require count without a measure, or sum/mean/median with a numeric size measure.",
				);
				requireSpec(
					spec.xMin === null && spec.yMin === null && spec.zeroBaseline,
					"Heatmaps use categorical axes and do not support numeric axis controls.",
				);
				break;
		}
		if (spec.type === "bar" || spec.type === "box")
			requireSpec(spec.xMin === null, "Categorical X axes do not support a numeric minimum.");
		if (spec.type === "line" && spec.xMin !== null)
			requireSpec(
				spec.x !== null && ["number", "datetime"].includes(columnAt(spec.x).basicType),
				"Explicit line X minima require a schema numeric or datetime field; inferred text axes must use automatic bounds.",
			);
	}
	if (!["bar", "box", "line"].includes(spec.type))
		requireSpec(
			spec.sort === "ascending",
			"This chart requires ascending coordinate order; category/value sorting is not supported.",
		);
	return spec;
}

/** Rules inspect only the existing bounded profile; they never query data or invoke a model. */
export function recommendCharts(profile: DatasetProfile): ChartRecommendation[] {
	const has = (column: ColumnProfile, type: SemanticType) =>
		column.semanticTypes.some((candidate) => candidate.type === type && candidate.confidence >= 0.7);
	const identifier = (column: ColumnProfile) =>
		has(column, "identifier") && /(?:^id$|[_\s]id$|identifier|uuid|key$)/iu.test(column.name);
	const numeric = profile.columns.filter(
		(column) => column.numeric !== null && has(column, "numeric") && !identifier(column),
	);
	const categories = profile.columns.filter(
		(column) =>
			!identifier(column) &&
			column.distinctCount >= 2 &&
			column.distinctCount <= CHART_MAX_CATEGORIES &&
			(has(column, "categorical") || has(column, "boolean")) &&
			!has(column, "datetime") &&
			!has(column, "numeric"),
	);
	const time = profile.columns.find((column) => has(column, "datetime") && !identifier(column));
	const basis = profile.sampling.approximate
		? `Approximate heuristic from ${profile.sampling.sampleSize} sampled rows of ${profile.sampling.populationRows}; observed cardinality is not a population estimate.`
		: `Deterministic heuristic from the current profile of ${profile.sampling.sampleSize} rows; semantic labels remain inferred.`;
	const recommendations: ChartRecommendation[] = [];
	const add = (type: ChartRecommendation["type"], x: number | null, y: number | null, reason: string) =>
		recommendations.push({ type, x, y, reason: `${reason} ${basis}` });
	if (numeric[0]) {
		add(
			"histogram",
			numeric[0].index,
			null,
			"Inspect a numeric distribution with bounded bins and count aggregation; invalid or missing values are excluded.",
		);
		add(
			"box",
			categories[0]?.index ?? null,
			numeric[0].index,
			"Compare numeric median, quartiles and whiskers, optionally grouped by a low-cardinality category.",
		);
	}
	if (categories[0])
		add(
			"bar",
			categories[0].index,
			null,
			`Count observations across ${categories[0].distinctCount} observed categories with a zero baseline and a capped category display.`,
		);
	if (time && numeric[0])
		add(
			"line",
			time.index,
			numeric[0].index,
			"Inspect numeric means over an inferred date/time field in chronological order; gaps do not imply observations.",
		);
	else if (numeric.length >= 2)
		add(
			"line",
			numeric[0].index,
			numeric[1].index,
			"Inspect numeric means against ordered numeric X; connecting observations does not establish causality or a time series.",
		);
	if (numeric.length >= 2) {
		add(
			"scatter",
			numeric[0].index,
			numeric[1].index,
			"Inspect paired numeric observations; the display is bounded to 1,000 points and may omit overplotted observations.",
		);
		add(
			"correlation",
			null,
			null,
			"Inspect pairwise Pearson correlations among up to the first 12 eligible numeric fields, using pairwise complete observations; correlation is not causation.",
		);
	}
	if (categories.length >= 2)
		add(
			"heatmap",
			categories[0].index,
			categories[1].index,
			"Compare counts at intersections of two low-cardinality fields; absent combinations are not observed cells.",
		);
	if (profile.columns.length)
		add(
			"missingness",
			null,
			null,
			"Inspect SQL NULL patterns in a bounded matrix of the first 24 fields; empty strings remain present and no missing values are imputed.",
		);
	add(
		"model-result",
		null,
		null,
		"Untrained placeholder only: no model has been fitted and no predictions or evaluation metrics exist.",
	);
	return recommendations;
}

/** ASCII JSON inside a Python string literal prevents labels, Unicode and backslashes becoming code. */
function pythonJSON(value: unknown): string {
	const json = JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	return JSON.stringify(json);
}

export function generateChartPython(result: ChartResult): string {
	const frozen = {
		spec: result.spec,
		datasetVersionHash: result.datasetVersionHash,
		generatedAt: result.generatedAt,
		populationRows: result.populationRows,
		sampleSize: result.sampleSize,
		stride: result.stride,
		byteLimited: result.byteLimited,
		sampled: result.sampled,
		filteredRows: result.filteredRows,
		excludedRows: result.excludedRows,
		omittedMarks: result.omittedMarks,
		marks: result.marks,
		labels: result.labels,
		warnings: result.warnings,
	};
	return `# Frozen deterministic workbench chart; Python is inspectable, never executed by the app.
# Requires only Python's standard library and matplotlib.
# Upstream worker selected a bounded deterministic systematic sample, applied the
# serialized filters to that sample, excluded invalid/missing values per chart,
# then computed bounded aggregates/coordinates. No population extrapolation occurs.
# This script plots those exact frozen marks, NOT a reimplementation over source data.
# Counts, box summaries, histogram bins, correlations and omissions are already fixed.
import json
import math
from datetime import datetime, timezone

chart = json.loads(${pythonJSON(frozen)})
spec = chart["spec"]
if spec["type"] == "model-result":
    raise RuntimeError("Untrained model-result placeholder: no model, predictions, or evaluation metrics exist.")

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.colors import Normalize
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Rectangle

# Dataset-supplied labels are literal text, including dollar signs and backslashes.
plt.rcParams["text.usetex"] = False
plt.rcParams["text.parse_math"] = False
PALETTE = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#D55E00", "#56B4E9", "#6B4C9A", "#595959", "#8C564B", "#BCBD22"]
SYMBOLS = ["o", "s", "^", "D", "v", "P", "X", "<", ">", "h"]
HATCHES = ["", "//", "xx", "..", "\\\\", "++", "oo", "--", "**", "||"]
marks = chart["marks"]
colors = list(dict.fromkeys(mark["color"] for mark in marks)) or [None]
facets = list(dict.fromkeys(mark["facet"] for mark in marks)) or [None]
color_index = {value: index for index, value in enumerate(colors)}
faceted = spec["facet"] is not None
columns = min(2, len(facets))
rows = math.ceil(len(facets) / columns)
fig, axes_grid = plt.subplots(rows, columns, figsize=(7 * columns, 5 * rows), squeeze=False)
axes = [axis for row in axes_grid for axis in row]


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def literal(value):
    return "(all)" if value is None else str(value)


def style(mark):
    index = color_index[mark["color"]]
    return PALETTE[index % len(PALETTE)], SYMBOLS[index % len(SYMBOLS)], HATCHES[index % len(HATCHES)]


def category_axis(axis, values, orientation="x"):
    positions = list(range(len(values)))
    if orientation == "x":
        axis.set_xticks(positions, [literal(value) for value in values], rotation=35, ha="right")
    else:
        axis.set_yticks(positions, [literal(value) for value in values])
    return {value: index for index, value in enumerate(values)}


def date_coordinate(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return mdates.date2num(parsed)
    except ValueError:
        return None


def domain(values, zero=False, minimum=None, padding=True):
    values = [value for value in values if finite(value)]
    low, high = (min(values), max(values)) if values else (0, 1)
    if zero:
        low, high = min(0, low), max(0, high)
    if minimum is not None:
        low = minimum
    if high <= low:
        high = low + max(1, abs(low) * 0.1)
    elif padding:
        extra = high / 20 - low / 20
        high += extra
        if minimum is None and not zero:
            low -= extra
    return low, high


x_categories = list(dict.fromkeys(mark["x"] for mark in marks))
y_categories = list(dict.fromkeys(mark["y"] for mark in marks))
kind = spec["type"]
numeric_line = kind == "line" and all(finite(mark["x"]) for mark in marks)
date_line = kind == "line" and "(ISO date order)" in chart["labels"]["x"]
size_max = max([max(0, mark["size"]) for mark in marks if finite(mark["size"])] or [0])

for axis, facet in zip(axes, facets):
    current = [mark for mark in marks if mark["facet"] == facet]
    axis.set_xlabel(chart["labels"]["x"])
    axis.set_ylabel(chart["labels"]["y"])
    if faceted:
        axis.set_title(chart["labels"]["facet"] + ": " + literal(facet))
    if not current:
        axis.text(0.5, 0.5, "No valid observations after filtering", transform=axis.transAxes, ha="center", va="center")
        continue
    if kind == "histogram":
        # The worker supplies bin boundaries. Never re-bin or expand counts.
        for mark in current:
            color, symbol, hatch = style(mark)
            width = mark["high"] - mark["low"]
            # A constant field has zero-width observed bounds, not a synthetic unit bin.
            if width <= 0:
                axis.vlines(mark["low"], 0, mark["value"], colors=color, linewidth=2)
                continue
            bar_width = width / max(1, len(colors))
            left = mark["low"] + color_index[mark["color"]] * bar_width
            axis.bar(left, mark["value"], width=bar_width, align="edge", color=color, hatch=hatch, edgecolor="#333333", linewidth=0.5)
        axis.set_xlim(*domain([mark[key] for mark in marks for key in ("low", "high")], minimum=spec["xMin"]))
    elif kind == "box":
        # bxp consumes fixed whiskers/quartiles/median without recomputing statistics.
        positions = category_axis(axis, x_categories)
        width = 0.8 / max(1, len(colors))
        for mark in current:
            color, symbol, hatch = style(mark)
            position = positions[mark["x"]] - 0.4 + width * (color_index[mark["color"]] + 0.5)
            summary = {"whislo": mark["low"], "q1": mark["q1"], "med": mark["median"], "q3": mark["q3"], "whishi": mark["high"], "fliers": []}
            axis.bxp([summary], positions=[position], widths=width * 0.7, showfliers=False, manage_ticks=False, patch_artist=True, boxprops={"facecolor": color, "hatch": hatch}, medianprops={"color": "#111111"})
        axis.set_xlim(-0.5, len(x_categories) - 0.5)
    elif kind == "bar":
        positions = category_axis(axis, x_categories)
        width = 0.8 / max(1, len(colors))
        for mark in current:
            color, symbol, hatch = style(mark)
            position = positions[mark["x"]] - 0.4 + width * (color_index[mark["color"]] + 0.5)
            axis.bar(position, mark["y"], width=width * 0.95, color=color, hatch=hatch, edgecolor="#333333", linewidth=0.5)
        axis.set_xlim(-0.5, len(x_categories) - 0.5)
    elif kind == "line":
        positions = None if numeric_line or date_line else category_axis(axis, x_categories)
        for group in colors:
            points = [mark for mark in current if mark["color"] == group]
            if not points:
                continue
            color, symbol, hatch = style(points[0])
            # Preserve worker order (including requested value/category sorting).
            x = [mark["x"] if numeric_line else date_coordinate(mark["x"]) if date_line else positions[mark["x"]] for mark in points]
            axis.plot(x, [mark["y"] for mark in points], color=color, marker=symbol, linewidth=1.5, markersize=5, label=literal(group))
        if date_line:
            axis.xaxis.set_major_locator(mdates.AutoDateLocator())
            axis.xaxis.set_major_formatter(mdates.ConciseDateFormatter(axis.xaxis.get_major_locator()))
        if numeric_line or date_line:
            coordinates = [mark["x"] if numeric_line else date_coordinate(mark["x"]) * 86400000 for mark in marks]
            # Date domains use original epoch milliseconds before converting units.
            limits = domain(coordinates, minimum=spec["xMin"], padding=not date_line)
            axis.set_xlim(*(tuple(value / 86400000 for value in limits) if date_line else limits))
        else:
            axis.set_xlim(-0.5, len(x_categories) - 0.5)
    elif kind == "scatter":
        for group in colors:
            points = [mark for mark in current if mark["color"] == group]
            if not points:
                continue
            color, symbol, hatch = style(points[0])
            # Match SVG radius mapping; matplotlib expresses marker area in points squared.
            radii = [max(2, math.sqrt(max(0, mark["size"]) / (size_max or 1)) * 12) if spec["size"] is not None and finite(mark["size"]) else 4 for mark in points]
            axis.scatter([mark["x"] for mark in points], [mark["y"] for mark in points], s=[math.pi * radius ** 2 for radius in radii], c=color, marker=symbol, alpha=0.8, edgecolors="#333333", linewidths=0.5, label=literal(group))
        axis.set_xlim(*domain([mark["x"] for mark in marks], zero=spec["zeroBaseline"], minimum=spec["xMin"]))
        if spec["size"] is not None:
            axis.text(0.01, 0.99, chart["labels"]["size"] + ": nonnegative area encoding with minimum visible radius; max=" + str(size_max), transform=axis.transAxes, va="top", fontsize=8)
    elif kind in ("heatmap", "correlation", "missingness"):
        x_positions = category_axis(axis, x_categories)
        y_positions = category_axis(axis, y_categories, "y")
        values = [mark["value"] for mark in marks if finite(mark["value"])]
        if kind == "correlation":
            norm, cmap = Normalize(-1, 1), plt.get_cmap("coolwarm")
        elif kind == "missingness":
            norm, cmap = Normalize(0, 1), plt.get_cmap("viridis")
        else:
            low, high = (min(values), max(values)) if values else (0, 1)
            norm, cmap = Normalize(min(0, low), max(1, high)), plt.get_cmap("viridis")
        for mark in current:
            value = mark["value"]
            fill = cmap(norm(value)) if finite(value) else "#eeeeee"
            rectangle = Rectangle((x_positions[mark["x"]] - 0.5, y_positions[mark["y"]] - 0.5), 1, 1, facecolor=fill, edgecolor="white", linewidth=0.5, hatch="//" if value is None else None)
            axis.add_patch(rectangle)
            if len(current) <= 100:
                text = "undefined" if value is None else format(value, ".3g")
                axis.text(x_positions[mark["x"]], y_positions[mark["y"]], text, ha="center", va="center", fontsize=8, color="#111111", bbox={"facecolor": "white", "alpha": 0.7, "edgecolor": "none", "pad": 0.2})
        axis.set_xlim(-0.5, len(x_categories) - 0.5)
        axis.set_ylim(len(y_categories) - 0.5, -0.5)
        fig.colorbar(plt.cm.ScalarMappable(norm=norm, cmap=cmap), ax=axis, label="SQL NULL (1) / present, including empty strings (0)" if kind == "missingness" else "Pearson r" if kind == "correlation" else chart["labels"]["aggregation"])
    else:
        raise ValueError("Unsupported frozen chart type")
    if kind not in ("heatmap", "correlation", "missingness"):
        y_values = [mark[key] for mark in marks for key in ("low", "high")] if kind == "box" else [mark["y"] for mark in marks]
        axis.set_ylim(*domain(y_values, zero=spec["zeroBaseline"], minimum=spec["yMin"]))
        axis.grid(axis="y", alpha=0.2)
        if spec["color"] is not None:
            handles = []
            for group in colors:
                index = color_index[group]
                color = PALETTE[index % len(PALETTE)]
                if kind in ("scatter", "line"):
                    handles.append(Line2D([], [], color=color, marker=SYMBOLS[index % len(SYMBOLS)], linestyle="-" if kind == "line" else "None", label=literal(group)))
                else:
                    handles.append(Patch(facecolor=color, hatch=HATCHES[index % len(HATCHES)], label=literal(group)))
            axis.legend(handles=handles, title=chart["labels"]["color"], fontsize=8)

for axis in axes[len(facets):]:
    axis.set_visible(False)
fig.suptitle(spec["type"] + " — frozen bounded observations")
notes = [chart["labels"]["aggregation"], chart["labels"]["filters"], chart["labels"]["missing"],
         "sample " + str(chart["sampleSize"]) + " / " + str(chart["populationRows"]) + "; retained after filters " + str(chart["filteredRows"]) + "; stride " + str(chart["stride"]),
         "excluded " + str(chart["excludedRows"]) + "; omitted marks " + str(chart["omittedMarks"]) + "; sampled=" + str(chart["sampled"]) + "; byte-limited=" + str(chart["byteLimited"])]
notes.extend(chart["warnings"])
fig.text(0.01, 0.01, "\\n".join(note for note in notes if note), ha="left", va="bottom", fontsize=8)
fig.tight_layout(rect=(0, min(0.45, 0.035 * len(notes)), 1, 0.95))
plt.savefig("chart.png", dpi=150, bbox_inches="tight")
plt.show()
`;
}
