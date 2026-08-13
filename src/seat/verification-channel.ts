import {
	createSubmissionChannel,
	type SubmissionChannel,
	type ToolResult,
} from "./channel-file.js";
import {
	formatVerificationErrors,
	type VerificationResult,
	validateVerification,
} from "./verification-schema.js";

type SubmitVerificationArguments = { items: unknown; regressions?: unknown };

export type SubmitVerificationTool = {
	name: "submit_verification";
	label: string;
	description: string;
	parameters: {
		type: "object";
		required: ["items"];
		properties: {
			items: { type: "array"; items: Record<string, never> };
			regressions: { type: "array"; items: Record<string, never> };
		};
	};
	execute: (
		toolCallId: string,
		params: SubmitVerificationArguments,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	) => Promise<ToolResult>;
};

/** Constructs the sole in-memory fix-verification submission channel. */
export function createSubmitVerificationTool({
	expectedIds,
	cycle,
	channel = createSubmissionChannel<VerificationResult>(),
}: {
	expectedIds: readonly string[];
	cycle: number;
	channel?: SubmissionChannel<VerificationResult>;
}): {
	tool: SubmitVerificationTool;
	channel: SubmissionChannel<VerificationResult>;
} {
	const tool: SubmitVerificationTool = {
		name: "submit_verification",
		label: "Submit verification",
		description:
			"Submit the complete verification result with one disposition row for every expected id and any direct regressions. This can be called once.",
		parameters: {
			type: "object",
			required: ["items"],
			properties: {
				items: { type: "array", items: {} },
				regressions: { type: "array", items: {} },
			},
		},
		async execute(
			_toolCallId,
			{ items, regressions },
			_signal,
			_onUpdate,
			_context,
		) {
			const validation = validateVerification(
				{ items, regressions: regressions ?? [] },
				expectedIds,
				cycle,
			);
			if (!validation.ok) {
				throw new Error(formatVerificationErrors(validation.errors));
			}
			channel.submit(validation.result);
			const count = validation.result.items.length;
			return {
				content: [
					{
						type: "text",
						text: `Submitted ${count} item disposition${count === 1 ? "." : "s."}`,
					},
				],
			};
		},
	};
	return { tool, channel };
}

export type { VerificationResult };
