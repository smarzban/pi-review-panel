/** The small common result shape accepted by Pi custom tools. */
export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
};

/**
 * A seat-local, write-once structured result channel. This replaces the old
 * filesystem handoff: only the custom role tool holds the closure, so model
 * bytes cross the seat boundary once and only after package validation.
 */
export type SubmissionChannel<T> = {
	submit: (value: T) => void;
	read: () => T | undefined;
	hasSubmitted: () => boolean;
};

export function createSubmissionChannel<T>(): SubmissionChannel<T> {
	let value: T | undefined;
	let submitted = false;

	return {
		submit(next) {
			if (submitted) {
				throw new Error("already submitted");
			}
			value = next;
			submitted = true;
		},
		read: () => value,
		hasSubmitted: () => submitted,
	};
}
