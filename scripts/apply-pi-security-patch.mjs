import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const workbenchManifest = join(repositoryRoot, "packages", "workbench", "package.json");
const expectedVersion = "1.3.0";
const expectedOriginalSha256 = "2dda468f4937edcf7bb5e8528de4bf7753efbe5b48610a3f9ea47ff2c4908ede";
const expectedPatchedSha256 = "44f9083f8783fb3c51fca2223f344358c79d23b497a5971e9230e8dafcbb472d";
const replacements = [
	["oauthErrorHtml(`${providerName} authorization failed.`, description)", "oauthErrorHtml(`${providerName} authorization failed.`)"],
	["new Error(`${providerName} authorization failed: ${description}`)", "new Error(`${providerName} authorization failed`)"] ,
	["oauthErrorHtml(`${providerName} sign-in failed.`, failure.message)", "oauthErrorHtml(`${providerName} sign-in failed.`)"],
];

function parseArguments() {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
		throw new Error("Usage: node scripts/apply-pi-security-patch.mjs [--check]");
	}
	return args[0] === "--check";
}

async function resolvePiAiPackage() {
	const requireFromWorkbench = createRequire(workbenchManifest);
	for (const dependencyPath of requireFromWorkbench.resolve.paths("@earendil-works/pi-ai") ?? []) {
		const directory = join(dependencyPath, "@earendil-works", "pi-ai");
		try {
			const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
			if (manifest.name === "@earendil-works/pi-ai") return { directory, manifest };
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	throw new Error("Unable to locate installed @earendil-works/pi-ai package from packages/workbench.");
}

async function main() {
	const checkOnly = parseArguments();
	const { directory: packageDirectory, manifest: packageJson } = await resolvePiAiPackage();
	if (packageJson.version !== expectedVersion) {
		throw new Error(`Pi callback patch requires pi-ai ${expectedVersion}; found ${packageJson.version}.`);
	}
	const callbackPath = join(packageDirectory, "dist", "auth", "oauth", "callback-server.js");
	const source = await readFile(callbackPath, "utf8");
	const sourceSha256 = createHash("sha256").update(source).digest("hex");
	if (sourceSha256 === expectedPatchedSha256) {
		console.log(`Pi ${expectedVersion} callback security patch is applied (${sourceSha256}).`);
		return;
	}
	if (checkOnly) {
		throw new Error(`Pi callback security patch is missing or unrecognized (sha256 ${sourceSha256}).`);
	}
	if (sourceSha256 !== expectedOriginalSha256) {
		throw new Error(`Pi ${expectedVersion} callback source hash is unrecognized (sha256 ${sourceSha256}); refusing to patch.`);
	}
	let patched = source;
	for (const [from, to] of replacements) {
		if (!patched.includes(from)) throw new Error("Pi callback source does not match audited Pi 1.3.0 target.");
		patched = patched.replace(from, to);
	}
	const patchedSha256 = createHash("sha256").update(patched).digest("hex");
	if (patchedSha256 !== expectedPatchedSha256) throw new Error(`Generated callback patch hash ${patchedSha256} does not match audit.`);
	await writeFile(callbackPath, patched, "utf8");
	console.log(`Applied Pi ${expectedVersion} callback security patch (${patchedSha256}).`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
