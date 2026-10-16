import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { estimateTokens, type ModelRoute, type ModelRouteRequest, type ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The only application-defined catalog entry; every destination comes from Pi availability. */
export function registerAutoModel(runtime: ModelRuntime): void {
	runtime.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto — Pi chooses",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		route: (request) => routeAutoModel(runtime, request),
	});
}

async function routeAutoModel(runtime: ModelRuntime, request: ModelRouteRequest): Promise<ModelRoute> {
	request.signal?.throwIfAborted();
	const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(request.signal ? [request.signal] : [])]);
	let available: readonly Model<Api>[];
	try {
		available = await runtime.getAvailable(undefined, { signal });
	} catch {
		throw new Error("Auto could not read available models. Check provider connections and try again.");
	}
	signal.throwIfAborted();
	const images = request.messages.some((message) =>
		Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
	);
	// Pi's estimator includes system sections, tool declarations, tool arguments and images.
	const inputTokens = request.messages.reduce((total, message) => total + estimateTokens(message) + 16, 0);
	const candidates = available.filter((model) => {
		if (!runtime.getPhysicalModel(model.provider, model.id)) return false;
		if (images && !model.input.includes("image")) return false;
		if (!getSupportedThinkingLevels(model).includes(request.thinkingLevel)) return false;
		const outputReserve = Math.min(model.maxTokens, 8192);
		return outputReserve > 0 && model.contextWindow >= inputTokens + outputReserve;
	});
	if (!candidates.length) {
		throw new Error("No available model supports this request's images, context size and thinking level. Connect a compatible provider or change the model.");
	}
	const preferred = request.reason === "continuation" ? request.previous?.model : request.reason === "retry" ? request.failed?.model : undefined;
	const prior = preferred && candidates.find((model) => model.provider === preferred.provider && model.id === preferred.id);
	if (prior) return { model: prior, thinkingLevel: request.thinkingLevel };
	// No classifier call or provider-specific ranking: choose the least estimated catalog cost.
	const cost = (model: Model<Api>) => {
		const value = model.cost.input * inputTokens + model.cost.output * Math.min(model.maxTokens, 8192);
		return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
	};
	let selected = candidates[0]!;
	let selectedCost = cost(selected);
	for (let index = 1; index < candidates.length; index++) {
		const candidate = candidates[index]!;
		const candidateCost = cost(candidate);
		if (candidateCost < selectedCost || (candidateCost === selectedCost && `${candidate.provider}/${candidate.id}` < `${selected.provider}/${selected.id}`)) {
			selected = candidate;
			selectedCost = candidateCost;
		}
	}
	return { model: selected, thinkingLevel: request.thinkingLevel };
}
