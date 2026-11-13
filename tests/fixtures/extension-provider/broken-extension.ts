// An extension whose factory throws while Pi loads it.
export default function brokenFixtureExtension(): void {
	throw new Error("review-panel fixture extension refuses to load");
}
