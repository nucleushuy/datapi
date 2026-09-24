import type { ChartResult } from "../chart-contracts.ts";
import { renderChart } from "./chart-renderer.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/2000/xmlns/";
const EXPORT_WIDTH = 720;
const FOOTER = { margin: 16, line: 16, size: 11 };

function notes(result: ChartResult): string[] {
	return [
		`${result.filteredRows} filtered rows / ${result.sampleSize} observed / ${result.populationRows} population. ${result.sampled ? "Systematic sample; never extrapolated." : "Full bounded scan."}`,
		`Stride: ${result.stride}. Byte limit reached: ${result.byteLimited ? "yes" : "no"}. Excluded rows: ${result.excludedRows}. Omitted marks: ${result.omittedMarks}.`,
		`Aggregation: ${result.labels.aggregation || result.spec.aggregation}. Filters: ${result.labels.filters || "None"}.`,
		`Missing values: ${result.labels.missing || "Not specified"}.`,
		...result.warnings.map((warning) => `Warning: ${warning}`),
		`Dataset version: ${result.spec.datasetVersionId}. Generated: ${result.generatedAt}.`,
		`Artifact SHA-256: ${result.datasetVersionHash}.`,
		"Frozen bounded analytical result. Original source dataset is not included. No Python or AI was executed.",
	];
}

function wrap(value: string, length: number): string[] {
	const lines: string[] = [];
	for (const paragraph of value.split(/\r?\n/)) {
		let remaining = paragraph;
		while (remaining.length > length) {
			const space = remaining.lastIndexOf(" ", length);
			const cut = space > length / 2 ? space : length;
			lines.push(remaining.slice(0, cut));
			remaining = remaining.slice(cut).trimStart();
		}
		lines.push(remaining);
	}
	return lines;
}

function serializedSvg(result: ChartResult): { source: string; width: number; height: number } {
	const container = document.createElement("div");
	renderChart(container, result);
	const root = container.querySelector("svg");
	if (!root) throw new Error("Chart export could not create an SVG.");
	// createElementNS plus a plain xmlns attribute can duplicate xmlns in XMLSerializer.
	root.removeAttribute("xmlns");
	root.setAttributeNS(XML_NS, "xmlns", SVG_NS);
	const width = Number(root.getAttribute("width")) || EXPORT_WIDTH;
	const previousHeight = Number(root.getAttribute("height"));
	const lines = notes(result).flatMap((note) =>
		wrap(note, Math.floor((width - FOOTER.margin * 2) / (FOOTER.size * 0.6))),
	);
	const height = previousHeight + FOOTER.margin * 2 + lines.length * FOOTER.line;
	root.setAttribute("viewBox", `0 0 ${width} ${height}`);
	root.setAttribute("width", String(width));
	root.setAttribute("height", String(height));
	root.querySelector("[data-chart-background]")?.setAttribute("height", String(height));
	const foreground = root.querySelector("text")?.getAttribute("fill") || "currentColor";
	const footer = document.createElementNS(SVG_NS, "g");
	footer.setAttribute("data-export-notes", "true");
	lines.forEach((line, index) => {
		const text = document.createElementNS(SVG_NS, "text");
		text.setAttribute("x", String(FOOTER.margin));
		text.setAttribute("y", String(previousHeight + FOOTER.margin + index * FOOTER.line));
		text.setAttribute("font-size", String(FOOTER.size));
		text.setAttribute("fill", foreground);
		text.textContent = line;
		footer.append(text);
	});
	root.append(footer);
	const metadata = document.createElementNS(SVG_NS, "metadata");
	metadata.setAttribute("data-chart-result", "true");
	metadata.textContent = JSON.stringify(result);
	root.append(metadata);
	const source = new XMLSerializer()
		.serializeToString(root)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "\ufffd");
	return { source, width, height };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

async function htmlExport(result: ChartResult, source: string): Promise<Blob> {
	// A hash permits this fixed stylesheet without allowing arbitrary inline styles or scripts.
	const style =
		":root{color-scheme:light dark}body{margin:2rem auto;padding:0 1rem;max-width:64rem;font-family:'Avenir Next','Segoe UI',sans-serif;line-height:1.5}svg{display:block;width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8125rem}summary{cursor:pointer;padding:.5rem 0}li+li{margin-top:.5rem}";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
	const policy = `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`;
	const title = `${result.spec.type} chart · ${result.labels.x}`;
	const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><main><h1>${escapeHtml(title)}</h1>${source}<section aria-label="Chart provenance"><h2>Provenance and limitations</h2><ul>${notes(
		result,
	)
		.map((note) => `<li>${escapeHtml(note)}</li>`)
		.join(
			"",
		)}</ul></section><details><summary>Frozen specification and bounded chart data</summary><pre data-chart-result="true">${escapeHtml(JSON.stringify(result, null, 2))}</pre></details></main></body></html>`;
	return new Blob([html], { type: "text/html;charset=utf-8" });
}

async function pngExport(source: string, width: number, height: number): Promise<Blob> {
	const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
	const image = new Image();
	try {
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("The chart image could not be loaded for PNG export."));
			image.src = url;
		});
		const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_777_216 / (width * height)));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.floor(width * scale));
		canvas.height = Math.max(1, Math.floor(height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("This browser cannot create a PNG canvas.");
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error("The browser could not encode the PNG image."))),
				"image/png",
			);
		});
	} finally {
		image.onload = null;
		image.onerror = null;
		URL.revokeObjectURL(url);
	}
}

/** Export only the frozen bounded result. Never fetch source rows or run generated code. */
export async function exportChart(
	result: ChartResult,
	format: "svg" | "png" | "html" | "json",
): Promise<{ blob: Blob; extension: string }> {
	if (format === "json")
		return {
			blob: new Blob([JSON.stringify(result, null, 2)], { type: "application/json;charset=utf-8" }),
			extension: "json",
		};
	const { source, width, height } = serializedSvg(result);
	if (format === "svg") return { blob: new Blob([source], { type: "image/svg+xml;charset=utf-8" }), extension: "svg" };
	if (format === "html") return { blob: await htmlExport(result, source), extension: "html" };
	if (format === "png") return { blob: await pngExport(source, width, height), extension: "png" };
	throw new Error("This chart export format is not supported.");
}
