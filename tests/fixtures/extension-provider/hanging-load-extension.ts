// An extension whose factory never settles, the way one might when it awaits a
// prompt or a socket during load. It registers nothing and touches nothing.
export default async function hangingLoadFixtureExtension(): Promise<void> {
	await new Promise(() => {});
}
