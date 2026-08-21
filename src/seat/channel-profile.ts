/**
 * The SDK seat channel profiles. A profile selects the exact read-only
 * tool allowlist, one terminating structured channel, and package-owned
 * instructions. It never selects a model or imports repository resources.
 */
export type FindingsProfile = {
	kind: "findings";
	tools: readonly ["read", "grep", "find", "ls", "git_diff", "submit_findings"];
	submitTool: "submit_findings";
	systemPrompt: string;
	outputChannelInstruction: string;
	noSubmitNudge: string;
};

export type RepoAuditProfile = {
	kind: "repo-audit";
	tools: readonly ["read", "grep", "find", "ls", "submit_findings"];
	submitTool: "submit_findings";
	systemPrompt: string;
	outputChannelInstruction: string;
	noSubmitNudge: string;
};

export type AuditProfile = {
	kind: "audit";
	tools: readonly ["read", "grep", "find", "ls", "git_diff", "submit_audit"];
	submitTool: "submit_audit";
	systemPrompt: string;
	outputChannelInstruction: string;
	noSubmitNudge: string;
};

export type VerificationProfile = {
	kind: "verification";
	tools: readonly [
		"read",
		"grep",
		"find",
		"ls",
		"git_diff",
		"submit_verification",
	];
	submitTool: "submit_verification";
	systemPrompt: string;
	outputChannelInstruction: string;
	noSubmitNudge: string;
};

export type FindingsSeatProfile = FindingsProfile | RepoAuditProfile;
export type SeatProfile =
	| FindingsSeatProfile
	| AuditProfile
	| VerificationProfile;

export const SEAT_PROFILES = {
	findings: {
		kind: "findings",
		tools: ["read", "grep", "find", "ls", "git_diff", "submit_findings"],
		submitTool: "submit_findings",
		systemPrompt:
			"You are a Review panel reviewer. Use only the supplied tools and record findings only through submit_findings.",
		outputChannelInstruction:
			"Findings are recorded ONLY via the submit_findings tool. Call it exactly once at the end of the review, or with an empty array if nothing is found. Inspect the change with git_diff using the base ref given above and the read-only tools.",
		noSubmitNudge:
			"you ended without calling submit_findings; findings are only recorded via that tool; call submit_findings now with the findings you identified, or an empty array if you found none; do not reply with prose",
	},
	"repo-audit": {
		kind: "repo-audit",
		tools: ["read", "grep", "find", "ls", "submit_findings"],
		submitTool: "submit_findings",
		systemPrompt:
			"You are a Review panel repository auditor. Use only the supplied tools and record findings only through submit_findings.",
		outputChannelInstruction:
			"Findings are recorded ONLY via the submit_findings tool. Explore the whole pinned repository with read, grep, find, and ls. Call submit_findings exactly once at the end, or with an empty array if nothing is found.",
		noSubmitNudge:
			"you ended without calling submit_findings; findings are only recorded via that tool; call submit_findings now with the findings you identified, or an empty array if you found none; do not reply with prose",
	},
	audit: {
		kind: "audit",
		tools: ["read", "grep", "find", "ls", "git_diff", "submit_audit"],
		submitTool: "submit_audit",
		systemPrompt:
			"You are a Review panel dismissal auditor. Use only the supplied tools and record audit results only through submit_audit.",
		outputChannelInstruction:
			"Audit results are recorded ONLY via the submit_audit tool. Call it exactly once at the end with one row for every expected id. Inspect the code with the read-only tools.",
		noSubmitNudge:
			"you ended without calling submit_audit; audit results are only recorded via that tool; call submit_audit now with one row for every expected id; do not reply with prose",
	},
	verification: {
		kind: "verification",
		tools: ["read", "grep", "find", "ls", "git_diff", "submit_verification"],
		submitTool: "submit_verification",
		systemPrompt:
			"You are a Review panel fix-verification reviewer. Use only the supplied tools and record verification results only through submit_verification.",
		outputChannelInstruction:
			"Verification results are recorded ONLY via the submit_verification tool. Call it exactly once at the end with one disposition row for every expected id and any direct regressions. Inspect the code with the read-only tools.",
		noSubmitNudge:
			"you ended without calling submit_verification; verification results are only recorded via that tool; call submit_verification now covering every expected id; do not reply with prose",
	},
} as const satisfies Record<SeatProfile["kind"], SeatProfile>;

export const DEFAULT_SEAT_PROFILE: FindingsProfile = SEAT_PROFILES.findings;
