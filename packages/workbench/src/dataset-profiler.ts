import type {
	ColumnProfile,
	DataIssue,
	DatasetProfile,
	Evidence,
	ProfileInput,
	SemanticType,
} from "./profile-contracts.ts";
import { PROFILER_VERSION } from "./profile-contracts.ts";
import { finiteNumber } from "./profiler.ts";

const CORRELATION_COLUMNS = 24;
const MAX_ISSUES = 128;

function numericValue(value: string | null): number | null {
	if (value === null || value === "") return null;
	const number = finiteNumber(value);
	if (number === null || (Number.isInteger(number) && !Number.isSafeInteger(number))) return null;
	if (number === 0 && /[1-9]/u.test(value.split(/[eE]/u)[0])) return null;
	return number;
}
function validDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?$/u.exec(
		value,
	);
	if (!match) return false;
	const year = Number(match[1]),
		month = Number(match[2]),
		day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= days[month - 1] &&
		(!match[4] || (Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60)) &&
		Number.isFinite(Date.parse(value))
	);
}
function quantile(sorted: number[], probability: number): number {
	const position = (sorted.length - 1) * probability;
	const index = Math.floor(position),
		fraction = position - index;
	return fraction === 0 ? sorted[index] : sorted[index] * (1 - fraction) + sorted[index + 1] * fraction;
}
function statistics(values: number[], excludedCount: number): ColumnProfile["numeric"] {
	if (!values.length) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	const min = sorted[0],
		max = sorted[sorted.length - 1];
	const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
	let mean = 0,
		m2 = 0,
		m3 = 0;
	for (let index = 0; index < values.length; index++) {
		const n = index + 1,
			delta = values[index] / scale - mean,
			step = delta / n;
		const term = delta * step * index;
		m3 += term * step * (n - 2) - 3 * step * m2;
		m2 += term;
		mean += step;
	}
	const p25 = quantile(sorted, 0.25),
		p75 = quantile(sorted, 0.75),
		iqr = p75 - p25;
	const lower = p25 - 1.5 * iqr,
		upper = p75 + 1.5 * iqr;
	const lowerFence = Number.isFinite(lower) ? lower : null,
		upperFence = Number.isFinite(upper) ? upper : null;
	const sd = values.length > 1 ? Math.sqrt(Math.max(0, m2) / (values.length - 1)) * scale : NaN;
	const skew =
		values.length > 2 && m2 > 0
			? (((values.length * Math.sqrt(values.length - 1)) / (values.length - 2)) * m3) / m2 ** 1.5
			: NaN;
	return {
		count: values.length,
		excludedCount,
		min,
		max,
		mean: Number.isFinite(mean * scale) ? mean * scale : null,
		median: quantile(sorted, 0.5),
		standardDeviation: Number.isFinite(sd) ? sd : null,
		quantiles: { p05: quantile(sorted, 0.05), p25, p75, p95: quantile(sorted, 0.95) },
		skewness: Number.isFinite(skew) ? skew : null,
		outlierCount: values.filter(
			(value) => (lowerFence !== null && value < lowerFence) || (upperFence !== null && value > upperFence),
		).length,
		lowerFence,
		upperFence,
		approximate: true,
	};
}

/** Statistics describe the supplied bounded sample; no sampled counts are extrapolated. */
export function computeDatasetProfile(
	input: ProfileInput,
	rows: (string | null)[][],
	sampling: DatasetProfile["sampling"],
	profiledAt: string,
): DatasetProfile {
	const size = rows.length;
	if (size !== sampling.sampleSize || rows.some((row) => row.length !== input.schema.length))
		throw new Error("Profile sample shape is invalid.");
	const issues: DataIssue[] = [];
	let omittedIssues = 0;
	const evidence = (metric: string, value: Evidence["value"], detail: string, approximate = false): Evidence => ({
		metric,
		value,
		basis: sampling.approximate ? "sample" : "full",
		rows: size,
		approximate: sampling.approximate || approximate,
		detail,
	});
	const addIssue = (
		kind: DataIssue["kind"],
		columns: number[],
		title: string,
		facts: Evidence[],
		proposedAction: string,
		severity: DataIssue["severity"] = "info",
		confidence = 0.8,
	) => {
		if (issues.length === MAX_ISSUES) {
			omittedIssues++;
			return;
		}
		issues.push({
			id: `${kind}:${columns.join(":")}`,
			kind,
			columns,
			title,
			confidence,
			severity,
			evidence: facts,
			proposedAction,
		});
	};
	const numericColumns: { index: number; values: (number | null)[] }[] = [];
	const targets: number[] = [];
	let eligibleNumeric = 0;
	const columns = input.schema.map((schema): ColumnProfile => {
		const scalar = schema.basicType !== "nested" && schema.basicType !== "binary";
		const frequencies = new Map<string, { count: number; label: string }>();
		const normalized = new Map<string, string>();
		const numeric: number[] = [],
			aligned: (number | null)[] = [];
		let nullCount = 0,
			emptyStringCount = 0,
			booleans = 0,
			dates = 0,
			variants = 0,
			invalidRange = 0;
		const geographic = /(?:^|[_\s])(?:lat|latitude|lon|lng|longitude)(?:$|[_\s])/iu.test(schema.name);
		const latitude = /(?:^|[_\s])(?:lat|latitude)(?:$|[_\s])/iu.test(schema.name);
		const nonnegative = /(?:^|[_\s])(?:age|count)(?:$|[_\s])/iu.test(schema.name);
		for (const row of rows) {
			const value = row[schema.index];
			const number = scalar ? numericValue(value) : null;
			aligned.push(number);
			if (value === null) {
				nullCount++;
				continue;
			}
			if (value === "") emptyStringCount++;
			const frequency = frequencies.get(value);
			if (frequency) frequency.count++;
			else frequencies.set(value, { count: 1, label: `Redacted value ${frequencies.size + 1}` });
			if (!scalar || value === "") continue;
			if (/^(?:true|false)$/iu.test(value)) booleans++;
			if (validDate(value)) dates++;
			const canonical = value.trim().toLowerCase();
			const first = normalized.get(canonical);
			if (first !== undefined && first !== value) variants++;
			else if (first === undefined) normalized.set(canonical, value);
			if (number !== null) {
				numeric.push(number);
				if (
					(geographic && (number < (latitude ? -90 : -180) || number > (latitude ? 90 : 180))) ||
					(nonnegative && (number < 0 || (/age/iu.test(schema.name) && number > 130)))
				)
					invalidRange++;
			}
		}
		const nonnull = size - nullCount,
			nonempty = nonnull - emptyStringCount;
		const semanticTypes: ColumnProfile["semanticTypes"] = [];
		const candidate = (type: SemanticType, confidence: number, reason: string) =>
			semanticTypes.push({ type, confidence, reason });
		const distinct = frequencies.size,
			ratio = nonnull ? distinct / nonnull : 0;
		const target = /(?:^|[_\s])(?:target|label|outcome|class|response)(?:$|[_\s])/iu.test(schema.name);
		if (scalar && nonempty) {
			if (numeric.length / nonempty >= 0.9)
				candidate(
					"numeric",
					numeric.length / nonempty,
					`${numeric.length} of ${nonempty} nonempty values are safely represented finite numbers.`,
				);
			if (booleans === nonempty) candidate("boolean", 1, `All ${nonempty} nonempty values are true/false text.`);
			if (dates / nonempty >= 0.9)
				candidate(
					"datetime",
					dates / nonempty,
					`${dates} of ${nonempty} nonempty values are calendar-valid ISO dates or timestamps.`,
				);
			if (distinct <= 20 || ratio <= 0.05)
				candidate(
					"categorical",
					0.8,
					`${distinct} distinct non-null values among ${nonnull} non-null observations.`,
				);
			if (numeric.length < nonempty && dates < nonempty && booleans < nonempty)
				candidate("text", 0.8, "Nonempty values include nonnumeric, nonboolean, nondatetime text.");
			if (ratio >= 0.95 && (/id$|identifier|uuid|key/iu.test(schema.name) || nonnull >= 20)) {
				candidate(
					"identifier",
					0.8,
					"At least 95% distinct non-null observations; uniqueness alone does not establish an identifier.",
				);
				addIssue(
					"identifier",
					[schema.index],
					"Potential identifier",
					[evidence("distinctCount", distinct, `Denominator: ${nonnull} non-null observations; threshold 95%.`)],
					"Verify stable uniqueness and exclude row identifiers from predictive features.",
				);
			}
			if (geographic && numeric.length)
				candidate(
					"geographic",
					0.8,
					"Coordinate-like column name and numeric observations; verify coordinate reference system.",
				);
		}
		if (numeric.length) {
			eligibleNumeric++;
			if (numericColumns.length < CORRELATION_COLUMNS) numericColumns.push({ index: schema.index, values: aligned });
		}
		const numericStats = statistics(numeric, nonempty - numeric.length);
		if (nullCount || emptyStringCount)
			addIssue(
				"missing",
				[schema.index],
				"Null or empty observations",
				[
					evidence("nullCount", nullCount, "Nulls; empty strings counted separately."),
					evidence(
						"emptyStringCount",
						emptyStringCount,
						"Empty string is not a null; confirm missing-value policy.",
					),
				],
				"Review missing-value meaning before imputing or removing rows.",
				"warning",
			);
		if (nonnull && distinct === 1)
			addIssue(
				"constant",
				[schema.index],
				"Constant non-null values",
				[evidence("distinctCount", 1, `${nonnull} non-null observations.`)],
				"Check whether this field carries useful information.",
			);
		if (nonnull >= 20 && ratio >= 0.9)
			addIssue(
				"high-cardinality",
				[schema.index],
				"High-cardinality field",
				[evidence("distinctCount", distinct, `${nonnull} non-null observations; threshold 90%.`)],
				"Consider encoding and privacy implications before modeling.",
			);
		if (dates && dates / nonempty >= 0.9)
			addIssue(
				"time",
				[schema.index],
				"Potential time column",
				[evidence("validDatetimeCount", dates, `${nonempty} nonempty values; calendar-valid ISO syntax.`)],
				"Verify timezone, ordering, and time-based train/test splits.",
			);
		if (scalar && target && nonempty) {
			targets.push(schema.index);
			addIssue(
				"target",
				[schema.index],
				"Potential target column",
				[evidence("nameRule", "target-like name", "Name-based heuristic only; analytical objective is unknown.")],
				"Confirm the outcome before choosing a model or features.",
				"info",
				0.6,
			);
		}
		if (invalidRange)
			addIssue(
				"invalid-range",
				[schema.index],
				"Values outside candidate range",
				[
					evidence(
						"invalidCount",
						invalidRange,
						geographic
							? `Name-implied coordinate range: ${latitude ? "[-90,90]" : "[-180,180]"}.`
							: "Name-implied nonnegative count/age; age upper bound 130 is heuristic.",
					),
				],
				"Verify units and domain constraints; inspect original values.",
				geographic ? "error" : "warning",
			);
		if (scalar && variants && (distinct <= 100 || ratio <= 0.1))
			addIssue(
				"inconsistent-category",
				[schema.index],
				"Case or whitespace category variants",
				[
					evidence(
						"variantObservations",
						variants,
						"Variants match earlier distinct values after trim and lowercase; raw cells remain unchanged.",
					),
				],
				"Review proposed normalization; distinct spellings may be intentional.",
				"warning",
			);
		const top = [...frequencies.values()].sort((a, b) => b.count - a.count);
		if (scalar && target && distinct > 1 && distinct <= 20 && nonnull >= 20 && top[0].count / nonnull >= 0.8)
			addIssue(
				"class-imbalance",
				[schema.index],
				"Candidate target class imbalance",
				[
					evidence(
						"largestClassCount",
						top[0].count,
						`${nonnull} non-null observations; largest class at least 80%.`,
					),
				],
				"Confirm classification target and use stratification and class-aware metrics.",
				"warning",
			);
		if (numericStats?.outlierCount)
			addIssue(
				"outlier",
				[schema.index],
				"Numeric outlier candidates",
				[
					evidence(
						"outlierCount",
						numericStats.outlierCount,
						`${numeric.length} accepted numeric observations; Tukey 1.5 IQR fences.`,
						true,
					),
					evidence("lowerFence", numericStats.lowerFence, "Approximate lower fence.", true),
					evidence("upperFence", numericStats.upperFence, "Approximate upper fence.", true),
				],
				"Inspect observations; an outlier is not necessarily erroneous.",
				"warning",
			);
		return {
			index: schema.index,
			name: schema.name,
			originalType: schema.sourceType,
			semanticTypes,
			nullCount,
			nullPercentage: size ? (nullCount / size) * 100 : null,
			emptyStringCount,
			distinctCount: distinct,
			distinctPercentage: nonnull ? (distinct / nonnull) * 100 : null,
			examples: [...frequencies.values()].slice(0, 3).map((entry) => entry.label),
			topValues: top.slice(0, 5),
			numeric: numericStats,
			limitations: [
				"Examples and top-value labels are fully redacted ordinal categories, scoped to this column and sample.",
				...(scalar
					? []
					: [
							"Nested/binary values use exact serialized text for counts; scalar semantic/numeric analysis is not applicable.",
						]),
				...(numericStats
					? [
							"Numeric arithmetic uses binary64 approximations; unsafe integers, nonfinite values, underflow, and nondecimal syntax are excluded. Empty and null values are not numeric exclusions.",
							"Quantiles use linear R-7 interpolation; standard deviation uses n-1; skewness uses adjusted Fisher-Pearson. Undefined or overflowing arithmetic is null.",
						]
					: []),
			],
		};
	});
	for (let left = 0; left < numericColumns.length; left++)
		for (let right = left + 1; right < numericColumns.length; right++) {
			const a = numericColumns[left],
				b = numericColumns[right];
			let scaleA = 0,
				scaleB = 0;
			for (let row = 0; row < size; row++) {
				const x = a.values[row],
					y = b.values[row];
				if (x !== null && y !== null) {
					scaleA = Math.max(scaleA, Math.abs(x));
					scaleB = Math.max(scaleB, Math.abs(y));
				}
			}
			if (!scaleA || !scaleB) continue;
			let mx = 0,
				my = 0,
				xx = 0,
				yy = 0,
				xy = 0,
				pairs = 0;
			for (let row = 0; row < size; row++) {
				const x = a.values[row],
					y = b.values[row];
				if (x === null || y === null) continue;
				pairs++;
				const dx = x / scaleA - mx,
					dy = y / scaleB - my;
				mx += dx / pairs;
				my += dy / pairs;
				xx += dx * (x / scaleA - mx);
				yy += dy * (y / scaleB - my);
				xy += dx * (y / scaleB - my);
			}
			if (pairs < 3 || xx <= 0 || yy <= 0) continue;
			const r = Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)));
			if (!Number.isFinite(r) || Math.abs(r) < 0.95) continue;
			const facts = [
				evidence("pearsonR", r, `${pairs} pairwise-complete observations; |r| >= 0.95, not causal evidence.`, true),
			];
			addIssue(
				"correlation",
				[a.index, b.index],
				"Highly correlated numeric fields",
				facts,
				"Inspect redundancy and confirm the relationship on held-out data.",
				"warning",
			);
			if (targets.includes(a.index) || targets.includes(b.index))
				addIssue(
					"leakage",
					[a.index, b.index],
					"Potential target leakage",
					facts,
					"Verify feature availability at prediction time; correlation does not prove leakage.",
					"warning",
					0.6,
				);
		}
	for (const target of targets.slice(0, 4))
		for (const column of columns.slice(0, CORRELATION_COLUMNS)) {
			if (
				column.index === target ||
				input.schema[column.index].basicType === "nested" ||
				input.schema[column.index].basicType === "binary"
			)
				continue;
			let compared = 0,
				equal = 0;
			for (const row of rows)
				if (row[target] !== null && row[target] !== "" && row[column.index] !== null && row[column.index] !== "") {
					compared++;
					if (row[target] === row[column.index]) equal++;
				}
			if (compared >= 3 && equal === compared)
				addIssue(
					"leakage",
					[target, column.index],
					"Candidate target copy",
					[evidence("equalValues", equal, `${compared} pairwise nonempty observations; exact text match.`)],
					"Confirm whether this field is derived from the outcome and unavailable at prediction time.",
					"warning",
					0.7,
				);
		}
	const uniqueRows = new Set<string>();
	let sampleBytes = 0;
	for (const row of rows) {
		const serialized = JSON.stringify(row);
		uniqueRows.add(serialized);
		sampleBytes += Buffer.byteLength(serialized);
	}
	return {
		profilerVersion: PROFILER_VERSION,
		datasetVersionId: input.datasetVersionId,
		datasetVersionHash: input.datasetVersionHash,
		profiledAt,
		rowCount: input.rowCount,
		columnCount: input.schema.length,
		sourceBytes: input.sourceBytes,
		storageBytes: input.storageBytes,
		estimatedMemoryBytes: size ? (sampleBytes / size) * input.rowCount : 0,
		duplicateCount: size - uniqueRows.size,
		sampling,
		columns,
		issues,
		limitations: [
			"Counts and percentages describe only profiled rows. Distinct percentages use non-null rows including empty strings. Duplicates count repeated rows after their first occurrence.",
			"Sampling uses deterministic row-index stride, not random sampling. Ordering/periodicity may bias results; rare values and relationships may be missed. No confidence intervals or population extrapolation of counts.",
			"Estimated memory is extrapolated serialized UTF-8 row bytes, not actual process memory or a storage quota.",
			"All semantic candidates and quality recommendations are heuristic; confidence is a rule score, not a statistical probability. No values are changed.",
			`Correlation considers the first ${CORRELATION_COLUMNS} eligible numeric columns (${eligibleNumeric} eligible); target-copy checks at most first 4 named targets and first ${CORRELATION_COLUMNS} fields.`,
			`At most ${MAX_ISSUES} findings retained; ${omittedIssues} additional findings omitted.`,
			...(sampling.byteLimited
				? ["Sample ended at the byte budget; later stride-selected rows were not inspected, adding prefix bias."]
				: []),
		],
	};
}
