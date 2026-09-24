import {
	CHART_MAX_CATEGORIES,
	CHART_MAX_FACETS,
	CHART_MAX_MARKS,
	CHART_RESULT_BYTES,
	CHART_SAMPLE_CELLS,
	CHART_SAMPLE_ROWS,
	CHART_TYPES,
	type ChartFilter,
	type ChartMark,
	type ChartResult,
	type ChartSample,
	type ChartSpec,
} from "./chart-contracts.ts";
import { finiteNumber } from "./profiler.ts";

const MAX_COLORS = 10;
const MAX_SCATTER = 1000;
const MAX_LINKS = 32_768;
const MAX_TABLE_BYTES = 512 * 1024;
const MAX_LABEL = 128;
type Row = ChartSample["rows"][number];
type AxisValue = number | string;
interface Group {
	x: AxisValue;
	y: AxisValue;
	color: string | null;
	facet: string | null;
	rows: Row[];
	values: number[];
	low: number | null;
	high: number | null;
}

/** Match the profiler's strict decimal, finite, safe-integer and underflow policy. */
function numeric(value: string | null): number | null {
	if (value === null || value === "") return null;
	const number = finiteNumber(value);
	if (number === null || (Number.isInteger(number) && !Number.isSafeInteger(number))) return null;
	if (number === 0 && /[1-9]/u.test(value.split(/[eE]/u)[0])) return null;
	return number;
}

/** ISO calendar dates or explicitly zoned instants only; never local-time parsing. */
function isoDate(value: string | null): number | null {
	if (value === null) return null;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2})))?$(?![\s\S])/u.exec(
			value,
		);
	if (!match) return null;
	const year = Number(match[1]),
		month = Number(match[2]),
		day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
	if (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)) return null;
	if (
		match[9] &&
		(Number(match[9]) > 14 || Number(match[10]) > 59 || (Number(match[9]) === 14 && Number(match[10]) !== 0))
	)
		return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function quantile(sorted: number[], probability: number): number {
	const position = (sorted.length - 1) * probability;
	const index = Math.floor(position),
		fraction = position - index;
	return fraction === 0 ? sorted[index] : sorted[index] * (1 - fraction) + sorted[index + 1] * fraction;
}

function aggregate(values: number[], count: number, aggregation: ChartSpec["aggregation"]): number {
	if (aggregation === "count") return count;
	if (aggregation === "median")
		return quantile(
			values.slice().sort((a, b) => a - b),
			0.5,
		);
	if (aggregation === "none") return values[0];
	// Compensated accumulation limits cancellation; results are still approximate doubles.
	let total = 0,
		correction = 0;
	for (const value of values) {
		const next = total + value;
		correction += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
		total = next;
	}
	return aggregation === "mean" ? (total + correction) / values.length : total + correction;
}

function blankMark(x: AxisValue, y: AxisValue, value: number | null): ChartMark {
	return {
		x,
		y,
		value,
		color: null,
		size: null,
		facet: null,
		low: null,
		high: null,
		q1: null,
		median: null,
		q3: null,
		rowIds: [],
	};
}

function compare(a: AxisValue, b: AxisValue): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	const left = String(a),
		right = String(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

function matches(value: string | null, filter: ChartFilter): boolean {
	switch (filter.op) {
		case "is-null":
			return value === null;
		case "not-null":
			return value !== null;
		case "eq":
			return value !== null && value === filter.value;
		case "neq":
			return value !== null && value !== filter.value;
		case "contains":
			return value?.includes(filter.value) ?? false;
		default: {
			const left = numeric(value),
				right = numeric(filter.value);
			if (left === null || right === null) return false;
			switch (filter.op) {
				case "gt":
					return left > right;
				case "gte":
					return left >= right;
				case "lt":
					return left < right;
				case "lte":
					return left <= right;
				default:
					throw new Error("Invalid chart configuration.");
			}
		}
	}
}

/** Compute only the bounded supplied sample: filtering precedes grouping; no extrapolation. */
export function computeChart(spec: ChartSpec, sample: ChartSample, hash: string, generatedAt: string): ChartResult {
	if (
		!CHART_TYPES.includes(spec.type) ||
		sample.rows.length > CHART_SAMPLE_ROWS ||
		sample.rows.length * sample.columns.length > CHART_SAMPLE_CELLS ||
		!Number.isInteger(spec.categoryLimit) ||
		spec.categoryLimit < 1 ||
		spec.categoryLimit > CHART_MAX_CATEGORIES ||
		!Number.isInteger(spec.bins) ||
		spec.bins < 1 ||
		spec.bins > 100
	)
		throw new Error("Invalid chart configuration.");
	const offsets = new Map<number, number>();
	for (let index = 0; index < sample.columns.length; index++) {
		if (offsets.has(sample.columns[index].index)) throw new Error("Invalid chart sample.");
		offsets.set(sample.columns[index].index, index);
	}
	for (const index of [
		spec.x,
		spec.y,
		spec.color,
		spec.size,
		spec.facet,
		...spec.filters.map((filter) => filter.column),
	]) {
		if (index !== null && !offsets.has(index)) throw new Error("Chart fields are unavailable.");
	}
	const ids = new Set<number>();
	for (const row of sample.rows) {
		if (
			!Number.isSafeInteger(row.rowId) ||
			row.rowId < 0 ||
			ids.has(row.rowId) ||
			row.values.length !== sample.columns.length ||
			row.values.some((value) => value !== null && typeof value !== "string")
		)
			throw new Error("Invalid chart sample.");
		ids.add(row.rowId);
	}
	const warnings = new Set<string>();
	const warn = (message: string) => {
		warnings.add(message);
	};
	const encoder = new TextEncoder();
	const valueAt = (row: Row, column: number | null): string | null =>
		column === null ? null : row.values[offsets.get(column)!];
	const field = (index: number | null, fallback = "None"): string => {
		if (index === null) return fallback;
		const name = sample.columns[offsets.get(index)!].name;
		if (name.length <= MAX_LABEL) return name;
		warn("Long field labels are shortened for display; table column metadata preserves original names.");
		return `${name.slice(0, MAX_LABEL)}… [field ${index}]`;
	};
	const categoryLabels = new Map<string, string>();
	const category = (value: string | null): string => {
		const key = value === null ? "NULL" : JSON.stringify(value);
		if (key.length <= MAX_LABEL) return key;
		let label = categoryLabels.get(key);
		if (label === undefined) {
			label = `${key.slice(0, MAX_LABEL)}… [category ${categoryLabels.size + 1}]`;
			categoryLabels.set(key, label);
			warn(
				"Long category labels are shortened with distinct identifiers; original values remain in the bounded table.",
			);
		}
		return label;
	};
	const filtered = sample.rows.filter((row) =>
		spec.filters.every((filter) => matches(valueAt(row, filter.column), filter)),
	);
	const sampled = sample.rows.length < sample.populationRows || sample.stride > 1 || sample.byteLimited;
	if (sampled)
		warn(
			"Chart uses a bounded deterministic sample; filters and aggregates describe sampled rows only and are not population estimates.",
		);
	if (sample.byteLimited) warn("The sample byte limit was reached; long records can reduce sample coverage.");
	warn("One quantitative Y axis is used; dual axes are unsupported because independent scales can mislead.");
	if (spec.xMin !== null || spec.yMin !== null)
		warn("Explicit axis minima truncate or extend the displayed scale; inspect hidden values and comparisons.");
	if (
		(spec.type === "bar" || spec.type === "histogram") &&
		(!spec.zeroBaseline || (spec.yMin !== null && spec.yMin !== 0))
	) {
		warn("A nonzero bar baseline can exaggerate differences; use a zero baseline for magnitude comparisons.");
	}
	const filterLabel =
		spec.filters.length === 0
			? "None; all sampled rows"
			: spec.filters
					.map((filter) => {
						const name = field(filter.column);
						if (filter.op === "is-null") return `${name} IS NULL`;
						if (filter.op === "not-null") return `${name} IS NOT NULL (empty strings included)`;
						return `${name} ${filter.op} ${JSON.stringify(filter.value)}${["gt", "gte", "lt", "lte"].includes(filter.op) ? " (strict numeric)" : " (case-sensitive text; NULL excluded)"}`;
					})
					.join(" AND ");
	const result: ChartResult = {
		spec,
		datasetVersionHash: hash,
		generatedAt,
		populationRows: sample.populationRows,
		sampleSize: sample.rows.length,
		stride: sample.stride,
		byteLimited: sample.byteLimited,
		sampled,
		filteredRows: filtered.length,
		excludedRows: 0,
		omittedMarks: 0,
		marks: [],
		table: { columns: sample.columns, rows: [] },
		warnings: [],
		labels: {
			x: field(spec.x, "All rows"),
			y: field(spec.y, "Row count"),
			color: field(spec.color),
			size: field(spec.size),
			facet: field(spec.facet),
			aggregation: `${spec.aggregation}; filtered sample only; no extrapolation`,
			filters: filterLabel,
			missing:
				"NULL is distinct from the empty string. Category strings are quoted; NULL is unquoted. Numeric marks exclude NULL, empty, invalid, unsafe integers and underflowed values.",
		},
	};
	let tableBytes = 0;
	for (const row of filtered) {
		if (result.table.rows.length === 100) break;
		const bytes = encoder.encode(JSON.stringify(row)).byteLength;
		if (tableBytes + bytes > MAX_TABLE_BYTES) continue;
		result.table.rows.push(row);
		tableBytes += bytes;
	}
	if (result.table.rows.length < filtered.length)
		warn(
			"The linked table shows at most 100 filtered sample rows within a 512 KiB value budget; not every selected row is visible.",
		);

	const covered = new Set<number>();
	const omittedKeys = new Set<string>();
	const omit = (key: string) => {
		if (!omittedKeys.has(key)) {
			omittedKeys.add(key);
			result.omittedMarks++;
		}
	};
	const domains = new Map<string, Set<string>>();
	const admit = (channel: string, key: string, cap: number): boolean => {
		let domain = domains.get(channel);
		if (!domain) {
			domain = new Set();
			domains.set(channel, domain);
		}
		if (domain.has(key)) return true;
		if (domain.size >= cap) {
			warn(
				`${channel} is limited to the first ${cap} distinct categories encountered; rows in additional categories are omitted, not merged or ranked globally.`,
			);
			return false;
		}
		domain.add(key);
		return true;
	};
	const encodings = (row: Row): { color: string | null; facet: string | null } | null => {
		const color = spec.color === null ? null : category(valueAt(row, spec.color));
		const facet = spec.facet === null ? null : category(valueAt(row, spec.facet));
		if (
			(color !== null && !admit("Color", color, MAX_COLORS)) ||
			(facet !== null && !admit("Facet", facet, CHART_MAX_FACETS))
		)
			return null;
		return { color, facet };
	};
	const markRows = (mark: ChartMark, rows: Row[], linkLimit = MAX_LINKS) => {
		for (const row of rows) covered.add(row.rowId);
		mark.rowIds =
			rows.length <= linkLimit ? rows.map((row) => row.rowId) : rows.slice(0, linkLimit).map((row) => row.rowId);
		if (rows.length > linkLimit)
			warn(
				"Linked selection is limited by the bounded row-ID payload; a mark may represent additional sample rows not highlighted.",
			);
		result.marks.push(mark);
	};
	const groups = new Map<string, Group>();
	const addGroup = (
		key: string,
		x: AxisValue,
		y: AxisValue,
		channels: { color: string | null; facet: string | null },
		row: Row,
		number: number | null,
		low: number | null = null,
		high: number | null = null,
	) => {
		let group = groups.get(key);
		if (!group) {
			if (groups.size >= CHART_MAX_MARKS) {
				omit(key);
				warn("The mark/group limit was reached; additional groups and their rows are omitted.");
				return;
			}
			group = { x, y, ...channels, rows: [], values: [], low, high };
			groups.set(key, group);
		}
		group.rows.push(row);
		if (number !== null) group.values.push(number);
	};
	const numericExclusion = () =>
		warn(
			"Inappropriate or missing numeric values were excluded: only strict finite decimals without unsafe integer coercion or underflow are plotted; decimal statistics are approximate.",
		);

	if (spec.type === "model-result") {
		result.labels.aggregation = "Not applicable: no model has been trained";
		result.labels.missing = "No data are plotted; model results require an explicitly trained model.";
		warn(
			"Untrained model-result placeholder: no model, predictions, scores, or feature importances have been computed.",
		);
	} else if (spec.type === "missingness") {
		const columns = sample.columns.filter((column) => column.index < 24);
		const rowLimit = columns.length === 0 ? 0 : Math.floor(CHART_MAX_MARKS / columns.length);
		const visible = filtered.slice(0, rowLimit);
		if (sample.columns.some((column) => column.index >= 24))
			warn(
				"Missingness displays only the first 24 source columns; additional projected filter fields are not matrix dimensions.",
			);
		if (visible.length < filtered.length)
			warn(
				"The missingness matrix shows only the first filtered sample rows that fit the 4096-cell limit; additional rows are omitted.",
			);
		result.omittedMarks = filtered.length * columns.length - visible.length * columns.length;
		for (const row of visible) {
			for (const column of columns) {
				const mark = blankMark(
					`${field(column.index)} [${column.index}]`,
					row.rowId,
					valueAt(row, column.index) === null ? 1 : 0,
				);
				markRows(mark, [row]);
			}
		}
		result.labels.x = "Fields (first 24 source columns; schema order)";
		result.labels.y = "Original zero-based source row ID";
		result.labels.aggregation = "None; one cell per sampled row and field";
		result.labels.missing = "1 = SQL NULL; 0 = present, including empty strings. NULL and empty are not conflated.";
	} else if (spec.type === "correlation") {
		const numericColumns = sample.columns.filter((column) => column.basicType === "number");
		const columns = numericColumns.slice(0, 12);
		if (numericColumns.length > columns.length)
			warn("Correlation displays only the first 12 numeric sampled columns in schema order.");
		const values = columns.map((column) => filtered.map((row) => numeric(valueAt(row, column.index))));
		const linkLimit = Math.max(1, Math.floor(MAX_LINKS / Math.max(1, columns.length ** 2)));
		const hasValues = values.some((column) => column.some((value) => value !== null));
		for (let x = 0; hasValues && x < columns.length; x++) {
			for (let y = 0; y < columns.length; y++) {
				const complete: Row[] = [];
				let scaleX = 0,
					scaleY = 0;
				for (let rowIndex = 0; rowIndex < filtered.length; rowIndex++) {
					const a = values[x][rowIndex],
						b = values[y][rowIndex];
					if (a === null || b === null) continue;
					scaleX = Math.max(scaleX, Math.abs(a));
					scaleY = Math.max(scaleY, Math.abs(b));
				}
				let meanX = 0,
					meanY = 0,
					varianceX = 0,
					varianceY = 0,
					covariance = 0;
				for (let rowIndex = 0; rowIndex < filtered.length; rowIndex++) {
					const rawX = values[x][rowIndex],
						rawY = values[y][rowIndex];
					if (rawX === null || rawY === null) continue;
					const a = rawX / (scaleX || 1),
						b = rawY / (scaleY || 1);
					complete.push(filtered[rowIndex]);
					const n = complete.length,
						dx = a - meanX,
						dy = b - meanY;
					meanX += dx / n;
					meanY += dy / n;
					varianceX += dx * (a - meanX);
					varianceY += dy * (b - meanY);
					covariance += dx * (b - meanY);
				}
				const raw =
					complete.length >= 2 && varianceX > 0 && varianceY > 0
						? covariance / (Math.sqrt(varianceX) * Math.sqrt(varianceY))
						: NaN;
				const correlation = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : null;
				markRows(
					blankMark(
						`${field(columns[x].index)} [${columns[x].index}]`,
						`${field(columns[y].index)} [${columns[y].index}]`,
						correlation,
					),
					complete,
					linkLimit,
				);
				if (correlation === null)
					warn(
						"Undefined correlations are empty cells, not zero: fewer than two complete pairs or a constant field has no Pearson coefficient.",
					);
			}
		}
		if (columns.length < 2) warn("Correlation needs at least two numeric fields for a meaningful comparison.");
		result.labels.x = "Numeric fields (first 12; schema order)";
		result.labels.y = "Numeric fields (first 12; schema order)";
		result.labels.aggregation =
			"Pairwise-complete Pearson correlation; approximate floating-point statistics on the filtered sample";
		result.labels.missing =
			"Each pair independently excludes NULL, empty and invalid/unsafe numeric values; pair sample sizes can differ. Constant or insufficient pairs are undefined.";
		warn("Correlation is not causation; pairwise deletion can compare different subsets and hide missing-data bias.");
	} else if (spec.type === "histogram") {
		const valid: { row: Row; number: number }[] = [];
		for (const row of filtered) {
			const number = numeric(valueAt(row, spec.x));
			if (number === null) {
				numericExclusion();
				continue;
			}
			valid.push({ row, number });
		}
		if (valid.length) {
			let min = valid[0].number,
				max = min;
			for (const entry of valid) {
				min = Math.min(min, entry.number);
				max = Math.max(max, entry.number);
			}
			let count = min === max ? 1 : spec.bins;
			let width = (max - min) / count;
			if (min !== max && (width === 0 || min + width === min || max - width === max)) {
				count = 1;
				width = max - min;
				warn(
					"Histogram bin edges cannot be distinguished at floating-point precision; the range is shown as one inclusive bin.",
				);
			}
			for (const { row, number } of valid) {
				const bin = width === 0 ? 0 : Math.min(count - 1, Math.floor((number - min) / width));
				const channels = encodings(row);
				const key = JSON.stringify([bin, category(valueAt(row, spec.color)), category(valueAt(row, spec.facet))]);
				if (!channels) {
					omit(key);
					continue;
				}
				const low = min + bin * width,
					high = bin === count - 1 ? max : min + (bin + 1) * width;
				addGroup(key, low, 0, channels, row, null, low, high);
			}
		}
		for (const group of groups.values()) {
			const mark = blankMark(group.x, group.rows.length, group.rows.length);
			Object.assign(mark, { color: group.color, facet: group.facet, low: group.low, high: group.high });
			markRows(mark, group.rows);
		}
		result.labels.y = "Sample row count";
		result.labels.aggregation =
			"Count per equal-width bin; [lower, upper), with the maximum included in the last bin; zero-count bins are not drawn";
		if (spec.color !== null)
			warn(
				"Histogram color groups share bin edges; overlapping groups can obscure counts. Compare separate facets when possible.",
			);
	} else if (spec.type === "scatter") {
		const positions = new Set<string>();
		for (const row of filtered) {
			const x = numeric(valueAt(row, spec.x)),
				y = numeric(valueAt(row, spec.y));
			const size = spec.size === null ? null : numeric(valueAt(row, spec.size));
			if (x === null || y === null || (spec.size !== null && (size === null || size < 0))) {
				numericExclusion();
				continue;
			}
			const channels = encodings(row);
			if (!channels || result.marks.length >= MAX_SCATTER) {
				omit(String(row.rowId));
				continue;
			}
			const key = JSON.stringify([x, y, channels.facet]);
			if (positions.has(key))
				warn("Overplotting: multiple rows share a scatter position; color or size may hide observations.");
			positions.add(key);
			const mark = blankMark(x, y, y);
			Object.assign(mark, channels, { size });
			markRows(mark, [row]);
		}
		if (result.marks.length > 500)
			warn("A dense scatter plot may overplot observations; use filters or facets to inspect density.");
		if (result.omittedMarks)
			warn(
				"Scatter displays at most 1000 eligible sample rows after color/facet caps; additional points are omitted without rescaling counts.",
			);
		result.labels.aggregation = "None; each mark is one filtered sample row";
		if (spec.size !== null)
			warn("Rows with missing, invalid or negative symbol sizes are excluded; zero size represents zero area.");
		if (spec.size !== null)
			result.labels.size = `${field(spec.size)} (nonnegative numeric; symbol area encodes value)`;
	} else {
		const isBox = spec.type === "box",
			isHeatmap = spec.type === "heatmap",
			isLine = spec.type === "line";
		const measure = isHeatmap ? spec.size : spec.y;
		let lineMode: "numeric" | "date" | "category" = "category";
		if (isLine && spec.x !== null) {
			const column = sample.columns[offsets.get(spec.x)!];
			const present = filtered
				.map((row) => valueAt(row, spec.x))
				.filter((value): value is string => value !== null && value !== "");
			if (column.basicType === "number" || (present.length > 0 && present.every((value) => numeric(value) !== null)))
				lineMode = "numeric";
			else if (
				column.basicType === "datetime" ||
				(present.length > 0 && present.every((value) => isoDate(value) !== null))
			)
				lineMode = "date";
			result.labels.x = `${field(spec.x)} (${lineMode === "date" ? "ISO date" : lineMode === "numeric" ? "numeric" : "categorical"} order)`;
			if (lineMode === "category")
				warn(
					"A line connects categorical values in the selected label order, not elapsed time; a bar chart is often more appropriate.",
				);
			if (spec.sort === "value-descending")
				warn(
					"Line groups are sorted by aggregate value, not X progression; connecting them does not represent chronological or numeric progression.",
				);
		}
		for (const row of filtered) {
			const number = isBox || spec.aggregation !== "count" ? numeric(valueAt(row, measure)) : null;
			if ((isBox || spec.aggregation !== "count") && number === null) {
				numericExclusion();
				continue;
			}
			let x: AxisValue;
			const groupedX = spec.x !== null;
			if (isLine && lineMode === "numeric") {
				const parsed = numeric(valueAt(row, spec.x));
				if (parsed === null) {
					numericExclusion();
					continue;
				}
				x = parsed;
			} else if (isLine && lineMode === "date") {
				const date = isoDate(valueAt(row, spec.x));
				if (date === null) {
					warn(
						"Invalid, impossible or timezone-ambiguous dates were excluded; line dates require strict ISO calendar dates or explicitly zoned instants.",
					);
					continue;
				}
				x = new Date(date).toISOString();
			} else x = groupedX ? category(valueAt(row, spec.x)) : isBox ? field(measure) : "All rows";
			const y: AxisValue = isHeatmap ? category(valueAt(row, spec.y)) : 0;
			const channels = encodings(row);
			const key = JSON.stringify([
				x,
				y,
				category(valueAt(row, spec.color)),
				category(valueAt(row, spec.facet)),
				spec.aggregation === "none" && !isBox ? row.rowId : null,
			]);
			if (
				!channels ||
				((!isLine || lineMode === "category") && !admit("X", String(x), spec.categoryLimit)) ||
				(isHeatmap && !admit("Y", String(y), spec.categoryLimit))
			) {
				omit(key);
				continue;
			}
			addGroup(key, x, y, channels, row, number);
		}
		let outliers = 0;
		for (const group of groups.values()) {
			if (isBox) {
				const sorted = group.values.sort((a, b) => a - b);
				const q1 = quantile(sorted, 0.25),
					median = quantile(sorted, 0.5),
					q3 = quantile(sorted, 0.75);
				const lowerFence = q1 - 1.5 * (q3 - q1),
					upperFence = q3 + 1.5 * (q3 - q1);
				let first = 0,
					last = sorted.length - 1;
				while (first < last && sorted[first] < lowerFence) first++;
				while (last > first && sorted[last] > upperFence) last--;
				outliers += first + sorted.length - 1 - last;
				const mark = blankMark(group.x, median, median);
				Object.assign(mark, {
					q1,
					median,
					q3,
					low: sorted[first],
					high: sorted[last],
					color: group.color,
					facet: group.facet,
				});
				markRows(mark, group.rows);
			} else {
				const value = aggregate(group.values, group.rows.length, spec.aggregation);
				if (!Number.isFinite(value)) {
					warn("An aggregate exceeded finite numeric range and was omitted rather than plotted inaccurately.");
					result.omittedMarks++;
					continue;
				}
				const mark = blankMark(group.x, isHeatmap ? group.y : value, value);
				Object.assign(mark, { color: group.color, facet: group.facet });
				markRows(mark, group.rows);
			}
		}
		if (isBox) {
			result.labels.x = field(spec.x, "All rows");
			result.labels.y = field(measure);
			result.labels.aggregation =
				"R7 quartiles and median; whiskers reach observed values within 1.5 × IQR fences; approximate filtered-sample statistics";
			if (outliers)
				warn(
					`${outliers} sample values lie outside box whiskers and are not drawn individually; linked memberships include them because they contribute to quartiles.`,
				);
		} else {
			result.labels.aggregation =
				spec.aggregation === "count"
					? "Count of filtered sample rows per group, including NULL and empty category values"
					: spec.aggregation === "none"
						? `No aggregation; individual valid ${field(measure)} observations`
						: `${spec.aggregation} of valid ${field(measure)} per group; approximate numeric statistics; filtered sample only`;
			if (!isHeatmap)
				result.labels.y =
					spec.aggregation === "count"
						? "Sample row count"
						: `${spec.aggregation === "none" ? "" : `${spec.aggregation} of `}${field(measure)}`;
			else
				result.labels.size =
					spec.aggregation === "count"
						? "Cell value: sample row count"
						: `Cell value: ${spec.aggregation} of ${field(measure)}`;
			if (spec.aggregation === "none" && (spec.type === "bar" || isLine))
				warn(
					"Unaggregated rows can share X positions and overplot; use an explicit aggregation for group comparisons.",
				);
		}
	}

	// Modern JS sort is stable; deterministic code-point order avoids machine locale differences.
	if (spec.type !== "missingness" && spec.type !== "correlation") {
		result.marks.sort((a, b) => {
			const facet = compare(a.facet ?? "", b.facet ?? "");
			if (facet) return facet;
			if (spec.sort === "value-descending")
				return (b.value ?? -Infinity) - (a.value ?? -Infinity) || compare(a.x, b.x) || compare(a.y, b.y);
			return (
				(spec.sort === "descending" ? -1 : 1) * (compare(a.x, b.x) || compare(a.y, b.y)) ||
				compare(a.color ?? "", b.color ?? "")
			);
		});
	}
	result.excludedRows = spec.type === "model-result" ? 0 : filtered.length - covered.size;
	if (result.excludedRows)
		warn(
			`${result.excludedRows} filtered sample rows are not represented by plotted marks because of missing/invalid values or display limits.`,
		);
	if (result.omittedMarks)
		warn(
			`${result.omittedMarks} candidate marks were omitted by display or numeric limits; shown values are not extrapolated.`,
		);
	if (!result.marks.length && spec.type !== "model-result")
		warn("No plottable values remain in the filtered sample; no synthetic observations were created.");
	result.warnings = [...warnings];
	// Metadata and unusual strings also count toward the worker's serialized response cap.
	if (encoder.encode(JSON.stringify(result)).byteLength > CHART_RESULT_BYTES) {
		result.table.rows = [];
		for (const mark of result.marks) mark.rowIds = [];
		warn("The result byte limit removed table rows and linked selection payload; plotted aggregates are unchanged.");
		result.warnings = [...warnings];
		if (encoder.encode(JSON.stringify(result)).byteLength > CHART_RESULT_BYTES)
			throw new Error("Chart result exceeds the supported size limit.");
	}
	return result;
}
