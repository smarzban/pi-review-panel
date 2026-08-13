import type { PanelRecord, StampedFinding } from "../run/types.js";

const OID_DISPLAY_LENGTH = 7;

export type CloseoutDismissed = {
	id: string;
	title: string;
	reason: string;
};

export type CloseoutLow = {
	id: string;
	title: string;
};

export type CloseoutCommentInput = {
	submitted: number;
	fixed: number;
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
	seats: string[];
	extras: string[];
	lost: string[];
	baseRef: string;
	baseOid: string;
	headRef?: string;
	headOid: string;
};

export type CloseoutJudgmentRow = {
	id: string;
	reason: string;
};

export type AccountCloseoutInput = {
	findings: readonly StampedFinding[];
	dismissed: readonly CloseoutJudgmentRow[];
	lowAdvisory: readonly string[];
};

export type AccountedCloseout = {
	submitted: number;
	fixed: StampedFinding[];
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
};

export type AssembleCloseoutInput = AccountCloseoutInput & {
	panel: PanelRecord;
	lost: readonly string[];
	meta: { baseRef: string; baseOid: string; headOid: string };
	headRef?: string;
};

function shortOid(oid: string): string {
	return oid.slice(0, OID_DISPLAY_LENGTH);
}

function requireReason(id: string, reason: string): string {
	const trimmed = reason.trim();
	if (trimmed === "") {
		throw new Error(`dismissed ${id} needs a reason`);
	}
	return trimmed;
}

/** Presentation-only close-out card. Counts and lists, no merge claim. */
export function renderCloseoutComment(input: CloseoutCommentInput): string {
	for (const row of input.dismissed) {
		requireReason(row.id, row.reason);
	}

	const findingWord = input.submitted === 1 ? "finding" : "findings";
	const extras =
		input.extras.length === 0 ? "" : ` · extras: ${input.extras.join(", ")}`;
	const lost = input.lost.length === 0 ? "none" : input.lost.join(", ");
	const headRef = input.headRef ?? "HEAD";
	const lines = [
		"## Review panel",
		"",
		`${input.submitted} ${findingWord} submitted · ${input.fixed} fixed · ${input.dismissed.length} dismissed · ${input.lowAdvisory.length} left as low/advisory`,
		`Seats: ${input.seats.join(", ")} (holistic)${extras}`,
		`Lost: ${lost}`,
		`\`${input.baseRef}\` (\`${shortOid(input.baseOid)}\`) → \`${headRef}\` (\`${shortOid(input.headOid)}\`)`,
	];
	if (input.dismissed.length > 0) {
		lines.push("", "### Dismissed");
		for (const row of input.dismissed) {
			lines.push(
				`- ${row.id} ${row.title} — ${requireReason(row.id, row.reason)}`,
			);
		}
	}
	if (input.lowAdvisory.length > 0) {
		lines.push("", "### Low / advisory (not kept)");
		for (const row of input.lowAdvisory) {
			lines.push(`- ${row.id} ${row.title}`);
		}
	}
	return lines.join("\n");
}

function uniqueInOrder(
	values: readonly string[],
	skip?: (value: string) => boolean,
): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const value of values) {
		if (skip?.(value) || seen.has(value)) {
			continue;
		}
		seen.add(value);
		ordered.push(value);
	}
	return ordered;
}

export function seatsFromPanel(panel: PanelRecord): {
	seats: string[];
	extras: string[];
} {
	return {
		seats: uniqueInOrder(
			panel.seats
				.filter((seat) => seat.lens === "holistic")
				.map((seat) => seat.rosterId),
		),
		extras: uniqueInOrder(
			panel.seats.map((seat) => seat.lens),
			(lens) => lens === "holistic" || lens === "fix-verification",
		),
	};
}

/** Split a review record into dismissed, leftover lows, and remaining (fixed) ids. */
export function accountCloseoutFindings(
	input: AccountCloseoutInput,
): AccountedCloseout {
	const byId = new Map(input.findings.map((row) => [row.id, row]));
	const claimed = new Set<string>();

	const dismissed: CloseoutDismissed[] = [];
	for (const row of input.dismissed) {
		const entry = byId.get(row.id);
		if (entry === undefined) {
			throw new Error(`dismissed ${row.id} is not in the review record`);
		}
		if (claimed.has(row.id)) {
			throw new Error(`${row.id} is listed more than once`);
		}
		claimed.add(row.id);
		dismissed.push({
			id: row.id,
			title: entry.finding.title,
			reason: requireReason(row.id, row.reason),
		});
	}

	const lowAdvisory: CloseoutLow[] = [];
	for (const id of input.lowAdvisory) {
		const entry = byId.get(id);
		if (entry === undefined) {
			throw new Error(`low/advisory ${id} is not in the review record`);
		}
		if (claimed.has(id)) {
			throw new Error(`${id} is listed more than once`);
		}
		if (entry.finding.severity !== "low") {
			throw new Error(
				`${id} is ${entry.finding.severity}; high/medium findings that are not kept must be dismissed with a reason, not listed as low/advisory`,
			);
		}
		claimed.add(id);
		lowAdvisory.push({ id, title: entry.finding.title });
	}

	const fixed: StampedFinding[] = [];
	for (const entry of input.findings) {
		if (claimed.has(entry.id)) {
			continue;
		}
		if (entry.finding.severity !== "low") {
			fixed.push(entry);
			continue;
		}
		throw new Error(
			`${entry.id} is low/advisory and was not listed; pass it in lowAdvisory or dismiss it with a reason`,
		);
	}

	return {
		submitted: input.findings.length,
		fixed,
		dismissed,
		lowAdvisory,
	};
}

/** Derive the close-out card from a review record plus orchestrator judgment. */
export function assembleCloseoutComment(input: AssembleCloseoutInput): string {
	const accounted = accountCloseoutFindings(input);
	const { seats, extras } = seatsFromPanel(input.panel);
	return renderCloseoutComment({
		submitted: accounted.submitted,
		fixed: accounted.fixed.length,
		dismissed: accounted.dismissed,
		lowAdvisory: accounted.lowAdvisory,
		seats,
		extras,
		lost: [...input.lost],
		baseRef: input.meta.baseRef,
		baseOid: input.meta.baseOid,
		headOid: input.meta.headOid,
		...(input.headRef === undefined ? {} : { headRef: input.headRef }),
	});
}
