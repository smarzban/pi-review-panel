// Loads cleanly, but registers a native provider Pi rejects when it applies
// the registration to the model runtime (a blank provider id). The failure
// therefore arrives as a services diagnostic, not as a load error.
type FixtureApi = { registerProvider: (provider: unknown) => void };

export default function rejectedRegistrationFixtureExtension(
	pi: FixtureApi,
): void {
	pi.registerProvider({ id: " ", name: "Rejected fixture", models: [] });
}
