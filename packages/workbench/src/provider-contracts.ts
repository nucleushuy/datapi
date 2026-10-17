export type ProviderAuthType = "oauth" | "api_key";
export type ProviderConnectionState =
	| "disconnected"
	| "connecting"
	| "waiting_browser"
	| "waiting_device"
	| "verifying"
	| "connected"
	| "expired"
	| "reconnect_required"
	| "cancelled"
	| "failed"
	| "environment"
	| "offline_cached";
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Display-only projections. Never expose Pi credentials, model headers or endpoint configuration. */
export interface ProviderModel {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	thinkingLevels: ModelThinkingLevel[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	billing: "subscription" | "api" | "virtual";
	virtual: boolean;
}
export interface ProviderSummary {
	id: string;
	name: string;
	auth: {
		oauth: { label: string; subscription: boolean } | null;
		apiKey: { label: string; interactive: boolean } | null;
	};
	state: ProviderConnectionState;
	configured: boolean;
	authType: ProviderAuthType | null;
	storedAuthType: ProviderAuthType | null;
	source: "stored" | "environment" | "runtime" | "configuration" | "virtual" | null;
	modelCount: number;
	message: string;
}
export interface ProviderCatalog {
	providers: ProviderSummary[];
	models: ProviderModel[];
	guidance: string;
}
export type ProviderAuthPrompt = {
	id: string;
	message: string;
} & (
	| { type: "text" | "secret" | "manual_code"; placeholder?: string }
	| { type: "select"; options: { id: string; label: string; description?: string }[] }
);
export type ProviderAuthEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresAt?: string }
	| { type: "progress"; message: string };
export interface ProviderAuthOperation {
	id: string;
	providerId: string;
	authType: ProviderAuthType;
	state: ProviderConnectionState;
	done: boolean;
	message: string;
	prompts: ProviderAuthPrompt[];
	events: ProviderAuthEvent[];
}
export interface SessionModelState {
	model: ProviderModel | null;
	thinkingLevel: ModelThinkingLevel;
	routedModel: { provider: string; id: string; name: string; thinkingLevel?: ModelThinkingLevel } | null;
}
export interface SessionModelSelection {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
	persist: boolean;
}
