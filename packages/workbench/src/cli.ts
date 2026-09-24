import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startWorkbench } from "./server.ts";
import { WorkbenchError } from "./storage.ts";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "4310" },
		"data-dir": { type: "string", default: join(homedir(), ".datapi", "workbench") },
		help: { type: "boolean", short: "h" },
	},
});

if (values.help) {
	console.log("Usage: npm run dev:workbench -- --port 4310 --data-dir <directory>");
	console.log("Local-only CSV and Parquet workbench. Defaults: port 4310, data in ~/.datapi/workbench.");
} else {
	try {
		if (!/^\d+$/.test(values.port)) throw new WorkbenchError(400, "Port must be an integer from 0 through 65535.");
		const port = Number(values.port);
		if (port > 65535) throw new WorkbenchError(400, "Port must be an integer from 0 through 65535.");
		const app = await startWorkbench({ port, dataDir: resolve(values["data-dir"]) });
		console.log(`Workbench ready at ${app.url}`);
		console.log("Local files only. No dataset content is sent to an LLM.");
		const stop = () => {
			void app.close().catch(() => {
				console.error("Could not cleanly close the workbench. Restart to recover unfinished imports.");
				process.exitCode = 1;
			});
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	} catch (error) {
		const message =
			error instanceof WorkbenchError
				? error.message
				: "Could not start the workbench. Check the port, dependencies, and data directory permissions.";
		console.error(message);
		process.exitCode = 1;
	}
}
