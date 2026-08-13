import {
	DEFAULT_SEAT_PROFILE,
	SEAT_PROFILES,
	type SeatProfile,
} from "./channel-profile.js";

export const OUTPUT_CHANNEL_INSTRUCTION =
	SEAT_PROFILES.findings.outputChannelInstruction;

export const SCOPE_BINDING =
	"The following scoping note is binding. Stay inside it. Prefer git_diff and targeted reads. Do not wander the rest of the repository.";

/**
 * Assembles the seat prompt. A scoping note, when present, leads so it is not
 * buried under the role text. Then: role prompt, base ref, channel instruction.
 */
export function assembleSeatPrompt({
	lensPrompt,
	baseRef,
	scopingNote,
	dataAppendix,
	profile,
}: {
	lensPrompt: string;
	baseRef: string;
	scopingNote?: string;
	dataAppendix?: string;
	profile?: SeatProfile;
}): string {
	const scopingSection =
		scopingNote === undefined ? "" : `${SCOPE_BINDING}\n\n${scopingNote}\n\n`;
	const channelInstruction =
		profile?.outputChannelInstruction ??
		DEFAULT_SEAT_PROFILE.outputChannelInstruction;
	const dataSection = dataAppendix === undefined ? "" : `\n\n${dataAppendix}`;

	return `${scopingSection}${lensPrompt}\n\nBase ref: ${baseRef}\n\n${channelInstruction}${dataSection}`;
}
