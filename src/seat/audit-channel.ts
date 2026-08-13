import type { AuditRow } from "./audit-schema.js";
import { formatAuditErrors, validateAudit } from "./audit-schema.js";
import {
	createSubmissionChannel,
	type SubmissionChannel,
	type ToolResult,
} from "./channel-file.js";

type SubmitAuditArguments = { rows: unknown };

export type SubmitAuditTool = {
	name: "submit_audit";
	label: string;
	description: string;
	parameters: {
		type: "object";
		required: ["rows"];
		properties: { rows: { type: "array"; items: Record<string, never> } };
	};
	execute: (
		toolCallId: string,
		params: SubmitAuditArguments,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	) => Promise<ToolResult>;
};

/** Constructs the sole in-memory claim-audit submission channel. */
export function createSubmitAuditTool({
	expectedIds,
	channel = createSubmissionChannel<AuditRow[]>(),
}: {
	expectedIds: readonly string[];
	channel?: SubmissionChannel<AuditRow[]>;
}): { tool: SubmitAuditTool; channel: SubmissionChannel<AuditRow[]> } {
	const tool: SubmitAuditTool = {
		name: "submit_audit",
		label: "Submit claim audit",
		description:
			"Submit the complete claim-audit result with one row for every expected claim id. This can be called once.",
		parameters: {
			type: "object",
			required: ["rows"],
			properties: { rows: { type: "array", items: {} } },
		},
		async execute(_toolCallId, { rows }, _signal, _onUpdate, _context) {
			const validation = validateAudit(rows, expectedIds);
			if (!validation.ok) {
				throw new Error(formatAuditErrors(validation.errors));
			}
			channel.submit(validation.rows);
			const count = validation.rows.length;
			return {
				content: [
					{
						type: "text",
						text: `Submitted ${count} audit row${count === 1 ? "." : "s."}`,
					},
				],
			};
		},
	};
	return { tool, channel };
}
