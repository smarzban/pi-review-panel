import {
	createSubmissionChannel,
	type SubmissionChannel,
	type ToolResult,
} from "./channel-file.js";
import { formatGroupsErrors, validateGroups } from "./grouping-schema.js";

type SubmitGroupsArguments = { groups: unknown };

export type SubmitGroupsTool = {
	name: "submit_groups";
	label: string;
	description: string;
	parameters: {
		type: "object";
		required: ["groups"];
		properties: {
			groups: { type: "array"; items: Record<string, never> };
		};
	};
	execute: (
		toolCallId: string,
		params: SubmitGroupsArguments,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	) => Promise<ToolResult>;
};

/**
 * Constructs the grouping seat's only submission channel. A submission that
 * does not place every expected id in exactly one group is refused by
 * throwing, which the seat sees as a tool error and may correct.
 */
export function createSubmitGroupsTool({
	expectedIds,
	channel = createSubmissionChannel<string[][]>(),
}: {
	expectedIds: readonly string[];
	channel?: SubmissionChannel<string[][]>;
}): { tool: SubmitGroupsTool; channel: SubmissionChannel<string[][]> } {
	const tool: SubmitGroupsTool = {
		name: "submit_groups",
		label: "Submit groups",
		description:
			"Submit the complete grouping: an array of groups, each { findingIds: [...] }, with every listed finding id in exactly one group. A finding with no duplicate is a group of one. This can be called once.",
		parameters: {
			type: "object",
			required: ["groups"],
			properties: {
				groups: { type: "array", items: {} },
			},
		},
		async execute(_toolCallId, { groups }, _signal, _onUpdate, _context) {
			const validation = validateGroups(groups, expectedIds);
			if (!validation.ok) {
				throw new Error(formatGroupsErrors(validation.errors));
			}
			channel.submit(validation.groups);
			const count = validation.groups.length;
			return {
				content: [
					{
						type: "text",
						text: `Submitted ${count} group${count === 1 ? "." : "s."}`,
					},
				],
			};
		},
	};
	return { tool, channel };
}
