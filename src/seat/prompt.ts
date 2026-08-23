import {
	DEFAULT_SEAT_PROFILE,
	SEAT_PROFILES,
	type SeatProfile,
} from "./channel-profile.js";

export const OUTPUT_CHANNEL_INSTRUCTION =
	SEAT_PROFILES.findings.outputChannelInstruction;

export const SCOPE_BINDING =
	"The following scoping note is binding. Stay inside it. Prefer git_diff and targeted reads. Do not wander the rest of the repository.";

export const AUDIT_SCOPE_BINDING =
	"The following scoping note is binding. Stay inside it. Explore with read, grep, find, and ls. Do not wander the rest of the repository.";

/**
 * Assembles the seat prompt. A scoping note, when present, leads so it is not
 * buried under the role text. Then: role prompt, optional diff base ref, channel instruction.
 */
export function assembleSeatPrompt({
	lensPrompt,
	baseRef,
	scopingNote,
	dataAppendix,
	profile,
}: {
	lensPrompt: string;
	baseRef?: string;
	scopingNote?: string;
	dataAppendix?: string;
	profile?: SeatProfile;
}): string {
	const scopeBinding =
		profile?.kind === "repo-audit" ? AUDIT_SCOPE_BINDING : SCOPE_BINDING;
	const scopingSection =
		scopingNote === undefined ? "" : `${scopeBinding}\n\n${scopingNote}\n\n`;
	const channelInstruction =
		profile?.outputChannelInstruction ??
		DEFAULT_SEAT_PROFILE.outputChannelInstruction;
	const dataSection = dataAppendix === undefined ? "" : `\n\n${dataAppendix}`;
	const baseSection =
		baseRef === undefined || profile?.kind === "repo-audit"
			? ""
			: `\n\nBase ref: ${baseRef}`;

	return `${scopingSection}${lensPrompt}${baseSection}\n\n${channelInstruction}${dataSection}`;
}
