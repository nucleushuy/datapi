import { fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/pi-ai";

/** Test-only provider registered with the real Pi runtime; no hosted authentication or inference. */
export function createAuthTestProvider() {
	const id = "future-test-provider";
	const counters = { oauth: 0, key: 0, refresh: 0, modelRefresh: 0 };
	let failLogin = false;
	let ambient = false;
	const faux = fauxProvider({
		provider: id,
		api: "openai-responses",
		models: [
			{ id: "analysis-model", name: "Analysis Model", contextWindow: 128000, maxTokens: 8192 },
			{ id: "image-model", name: "Image Model", contextWindow: 256000, maxTokens: 16384, input: ["text", "image"] },
		],
	});
	faux.setResponses([fauxAssistantMessage("Local Pi provider response. No external request was made.")]);
	const provider: Provider = {
		...faux.provider,
		name: "Future Test Provider",
		headers: { authorization: "private-provider-header" },
		auth: {
			apiKey: {
				name: "Future Test API key",
				async login(interaction) {
					counters.key++;
					const key = await interaction.prompt({ type: "secret", message: "Enter Future Test API key" });
					if (failLogin) throw new Error("private-provider-error secret-access-token");
					return { type: "api_key", key };
				},
				async resolve({ credential }) {
					return credential?.key
						? { auth: { apiKey: credential.key }, source: "Saved API key" }
						: ambient
							? { auth: { apiKey: "private-ambient-key" }, source: "TEST_PROVIDER_KEY" }
							: undefined;
				},
			},
			oauth: {
				name: "Future Test OAuth",
				loginLabel: "Sign in with Future Test",
				isSubscription: true,
				async login(interaction) {
					counters.oauth++;
					interaction.notify({ type: "info", message: "Test-only Pi authentication flow." });
					await interaction.prompt({ type: "text", message: "Workspace label", placeholder: "Local workspace" });
					const flow = await interaction.prompt({
						type: "select",
						message: "Choose authentication flow",
						options: [{ id: "browser", label: "Browser" }, { id: "device", label: "Device code" }],
					});
					if (flow === "device") {
						interaction.notify({ type: "device_code", userCode: "LOCAL-1234", verificationUri: "https://example.invalid/device", expiresInSeconds: 120 });
					} else {
						interaction.notify({ type: "auth_url", url: "https://example.invalid/authorize?state=fixture", instructions: "Complete the local test flow." });
					}
					await interaction.prompt({ type: "manual_code", message: "Enter authorization code or redirect URL" });
					interaction.notify({ type: "progress", message: "Completing Pi authentication" });
					if (failLogin) throw new Error("private-provider-error secret-access-token");
					return { type: "oauth", access: "secret-access-token", refresh: "secret-refresh-token", expires: Date.now() + 3600000 };
				},
				async refresh(credential) {
					counters.refresh++;
					return { ...credential, expires: Date.now() + 3600000 };
				},
				async toAuth(credential) { return { apiKey: credential.access }; },
			},
		},
		async refreshModels() { counters.modelRefresh++; },
	};
	return {
		provider,
		faux,
		counters,
		setFailLogin(value: boolean) { failLogin = value; },
		setAmbient(value: boolean) { ambient = value; },
	};
}
