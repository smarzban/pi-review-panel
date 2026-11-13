// A Pi extension that registers native providers, the way pi-claude-code
// does. Pi's extension loader aliases "@earendil-works/pi-ai" for every
// extension, so this import resolves at load time even though the package is
// only nested under the SDK. Nothing here touches the network or a process.
// @ts-expect-error Resolved by Pi's extension loader alias, not by this repo.
import { createProvider } from "@earendil-works/pi-ai";

type FixtureApi = { registerProvider: (provider: unknown) => void };
type LoadCounter = { __reviewPanelFixtureLoads?: number };

function fixtureModel(provider: string, id: string) {
	return {
		id,
		name: `${id} (fixture)`,
		api: "review-panel-fixture",
		provider,
		baseUrl: "process://review-panel-fixture",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_000,
		maxTokens: 1_000,
	};
}

function refuseStream(): never {
	throw new Error("the review-panel fixture provider never runs a model");
}

/**
 * `configured` mirrors a logged-in Claude Code CLI: `check` reports auth.
 * Otherwise it mirrors a CLI that is not logged in: `check` returns undefined
 * while `resolve` still returns a request credential, exactly the shape where
 * `getAuth` alone would wrongly report the provider authenticated.
 */
function fixtureProvider(id: string, configured: boolean) {
	return createProvider({
		id,
		name: `Review panel fixture ${id}`,
		baseUrl: "process://review-panel-fixture",
		auth: {
			apiKey: {
				name: "Fixture login",
				async check() {
					return configured
						? { type: "api_key", source: "review-panel fixture" }
						: undefined;
				},
				async resolve() {
					return {
						auth: { apiKey: "external-process" },
						source: "review-panel fixture",
					};
				},
			},
		},
		models: [fixtureModel(id, "fixture-model")],
		api: { stream: refuseStream, streamSimple: refuseStream },
	});
}

export default function reviewPanelFixtureExtension(pi: FixtureApi): void {
	const counter = globalThis as LoadCounter;
	counter.__reviewPanelFixtureLoads =
		(counter.__reviewPanelFixtureLoads ?? 0) + 1;
	pi.registerProvider(fixtureProvider("review-panel-fixture", true));
	pi.registerProvider(fixtureProvider("review-panel-fixture-unauthed", false));
}
