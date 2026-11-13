// Registers a provider whose own auth `check` throws, the way an extension
// might when the CLI it asks is missing. Nothing here touches the network.
// @ts-expect-error Resolved by Pi's extension loader alias, not by this repo.
import { createProvider } from "@earendil-works/pi-ai";

type FixtureApi = { registerProvider: (provider: unknown) => void };

function refuseStream(): never {
	throw new Error("the review-panel fixture provider never runs a model");
}

export default function throwingCheckFixtureExtension(pi: FixtureApi): void {
	const id = "review-panel-fixture-throwing";
	pi.registerProvider(
		createProvider({
			id,
			name: "Review panel fixture with a throwing check",
			baseUrl: "process://review-panel-fixture",
			auth: {
				apiKey: {
					name: "Fixture login",
					async check() {
						throw new Error("review-panel fixture CLI is missing");
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
