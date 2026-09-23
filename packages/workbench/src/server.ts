import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { MAX_UPLOAD_BYTES } from "./contracts.ts";
import { WorkbenchError, WorkbenchStore } from "./storage.ts";

export interface WorkbenchOptions {
	dataDir: string;
	port?: number;
}

export interface WorkbenchApplication {
	url: string;
	close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

async function readName(request: IncomingMessage): Promise<string> {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
		throw new WorkbenchError(415, "Send a JSON request.");
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > 4096) throw new WorkbenchError(413, "Request is too large.");
		chunks.push(chunk);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new WorkbenchError(400, "Request contains invalid JSON.");
	}
	if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") {
		throw new WorkbenchError(400, "A name is required.");
	}
	return value.name;
}

export async function startWorkbench(options: WorkbenchOptions): Promise<WorkbenchApplication> {
	const port = options.port ?? 4310;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be between 0 and 65535.");
	const [bundle, html, css] = await Promise.all([
		build({
			entryPoints: [fileURLToPath(new URL("./browser/app.ts", import.meta.url))],
			bundle: true,
			write: false,
			platform: "browser",
			format: "esm",
			target: "es2022",
			logLevel: "silent",
		}),
		readFile(new URL("./browser/index.html", import.meta.url)),
		readFile(new URL("./browser/style.css", import.meta.url)),
	]);
	const script = bundle.outputFiles[0]?.contents;
	if (!script) throw new Error("Browser bundle is missing.");
	const assets: Record<string, { type: string; content: Uint8Array } | undefined> = {
		"/": { type: "text/html; charset=utf-8", content: html },
		"/app.js": { type: "text/javascript; charset=utf-8", content: script },
		"/style.css": { type: "text/css; charset=utf-8", content: css },
	};
	const store = new WorkbenchStore(options.dataDir);
	await store.init();
	const token = randomBytes(32).toString("hex");
	const tokenBytes = Buffer.from(token);
	let origin = "";
	let authority = "";

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		);
		if (
			request.headers.host !== authority ||
			(request.headers.origin !== undefined && request.headers.origin !== origin) ||
			(request.headers["sec-fetch-site"] !== undefined &&
				request.headers["sec-fetch-site"] !== "same-origin" &&
				request.headers["sec-fetch-site"] !== "none")
		) {
			throw new WorkbenchError(403, "Only same-origin local requests are allowed.");
		}
		const url = new URL(request.url ?? "/", origin);
		const path = url.pathname;
		const method = request.method;
		if (method === "GET" && path === "/api/bootstrap") {
			json(response, 200, { token, projects: await store.listProjects(), maxUploadBytes: MAX_UPLOAD_BYTES });
			return;
		}
		if (!path.startsWith("/api/")) {
			const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
			if (!asset || (method !== "GET" && method !== "HEAD")) throw new WorkbenchError(404, "Not found.");
			response.writeHead(200, { "Content-Type": asset.type });
			response.end(method === "HEAD" ? undefined : asset.content);
			return;
		}
		const credential = request.headers["x-workbench-token"];
		if (
			typeof credential !== "string" ||
			Buffer.byteLength(credential) !== tokenBytes.length ||
			!timingSafeEqual(Buffer.from(credential), tokenBytes)
		) {
			throw new WorkbenchError(403, "This session has expired. Reload the workbench.");
		}
		const parts = path.split("/").filter(Boolean);
		if (path === "/api/projects") {
			if (method === "GET") {
				json(response, 200, await store.listProjects());
				return;
			}
			if (method === "POST") {
				json(response, 201, await store.createProject(await readName(request)));
				return;
			}
		}
		if (parts[1] === "projects" && parts[2]) {
			const projectId = parts[2];
			if (parts.length === 4 && parts[3] === "imports" && method === "POST") {
				json(response, 201, await store.createImport(projectId, await readName(request)));
				return;
			}
			if (parts[3] === "datasets") {
				if (parts.length === 4 && method === "GET") {
					json(response, 200, await store.listDatasets(projectId));
					return;
				}
				const datasetId = parts[4];
				if (datasetId && parts.length === 5 && method === "GET") {
					json(response, 200, await store.getDataset(projectId, datasetId));
					return;
				}
				if (datasetId && parts.length === 6 && parts[5] === "preview" && method === "GET") {
					const offsetText = url.searchParams.get("offset") ?? "0";
					if (!/^\d+$/.test(offsetText))
						throw new WorkbenchError(400, "Preview offset must be a nonnegative integer.");
					json(response, 200, await store.preview(projectId, datasetId, Number(offsetText)));
					return;
				}
				if (datasetId && parts.length === 6 && parts[5] === "reprofile" && method === "POST") {
					json(response, 202, await store.reprofile(projectId, datasetId));
					return;
				}
			}
		}
		if (parts[1] === "imports" && parts[2]) {
			const jobId = parts[2];
			if (parts.length === 3 && method === "GET") {
				json(response, 200, store.getJob(jobId));
				return;
			}
			if (parts.length === 3 && method === "DELETE") {
				json(response, 200, await store.cancel(jobId));
				return;
			}
			if (parts.length === 4 && parts[3] === "content" && method === "PUT") {
				const contentType = request.headers["content-type"]?.split(";")[0].trim();
				if (contentType !== "text/csv" && contentType !== "application/octet-stream") {
					throw new WorkbenchError(415, "Upload raw CSV bytes, not a form attachment.");
				}
				if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) {
					throw new WorkbenchError(413, "CSV files must be 100 MB or smaller.");
				}
				request.setTimeout(30_000, () => request.destroy());
				try {
					const job = await store.upload(jobId, request.iterator({ destroyOnReturn: false }));
					if (!request.complete) response.setHeader("Connection", "close");
					json(response, 202, job);
				} finally {
					request.setTimeout(0);
				}
				return;
			}
		}
		throw new WorkbenchError(404, "Not found.");
	}

	const server = createServer({ requestTimeout: 300_000, headersTimeout: 15_000 }, (request, response) => {
		void handle(request, response).catch((error: unknown) => {
			if (response.destroyed || response.writableEnded) return;
			// Close unread request bodies instead of allowing unbounded draining.
			response.setHeader("Connection", "close");
			json(response, error instanceof WorkbenchError ? error.status : 500, {
				error:
					error instanceof WorkbenchError
						? error.message
						: "The local operation failed. Check disk access and try again.",
			});
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		await store.close();
		throw error;
	}
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Local server did not acquire a TCP port.");
	authority = `127.0.0.1:${address.port}`;
	origin = `http://${authority}`;
	let closing: Promise<void> | undefined;
	return {
		url: origin,
		close() {
			closing ??= (async () => {
				const stopped = new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				});
				server.closeAllConnections();
				await store.close();
				await stopped;
			})();
			return closing;
		},
	};
}
