// Registers a provider whose own auth `check` never settles, the way an extension
// might when the CLI it asks waits on a login prompt. Nothing here touches the network.
import { createProvider } from "@earendil-works/pi-ai";

type FixtureApi = { registerProvider: (provider: unknown) => void };

function refuseStream(): never {
	throw new Error("the review-panel fixture provider never runs a model");
}

export default function hangingCheckFixtureExtension(pi: FixtureApi): void {
	const id = "review-panel-fixture-hanging";
	pi.registerProvider(
		createProvider({
			id,
			name: "Review panel fixture with a check that never settles",
			baseUrl: "process://review-panel-fixture",
			auth: {
				apiKey: {
					name: "Fixture login",
					async check() {
						return new Promise(() => {});
					},
					async resolve() {
						return { auth: { apiKey: "external-process" } };
					},
				},
			},
			models: [
				{
					id: "fixture-model",
					name: "fixture-model (fixture)",
					api: "review-panel-fixture",
					provider: id,
					baseUrl: "process://review-panel-fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8_000,
					maxTokens: 1_000,
				},
			],
			api: { stream: refuseStream, streamSimple: refuseStream },
		}),
	);
}
