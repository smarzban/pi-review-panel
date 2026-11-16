import {
	createSubmissionChannel,
	type SubmissionChannel,
	type ToolResult,
} from "./channel-file.js";
import {
	EVIDENCE_MAX,
	EXPLANATION_MAX,
	explanationLimitErrors,
	TITLE_MAX,
	textLimitErrors,
} from "./text-limits.js";
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
	undoableIds = [],
	channel = createSubmissionChannel<VerificationResult>(),
}: {
	expectedIds: readonly string[];
	cycle: number;
	/** Ids an earlier round resolved, which a regression may say it undoes. */
	undoableIds?: readonly string[];
	channel?: SubmissionChannel<VerificationResult>;
}): {
	tool: SubmitVerificationTool;
	channel: SubmissionChannel<VerificationResult>;
} {
	const tool: SubmitVerificationTool = {
		name: "submit_verification",
		label: "Submit verification",
		description: `Submit the complete verification result with one disposition row for every expected id and any direct regressions. Each evidence explanation is at most ${EXPLANATION_MAX} characters. A regression row has file, line, title (the problem, at most ${TITLE_MAX} characters) and evidence (at most ${EVIDENCE_MAX} characters); set its undoes field to an id only when the scope lists that id as resolved by an earlier round and this fix range undoes that fix. This can be called once.`,
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
				undoableIds,
			);
			if (!validation.ok) {
				throw new Error(formatVerificationErrors(validation.errors));
			}
			const tooLong = [
				...explanationLimitErrors(validation.result.items),
				...textLimitErrors(validation.result.regressions, "regressions"),
			];
			if (tooLong.length > 0) {
				throw new Error(tooLong.join("; "));
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
