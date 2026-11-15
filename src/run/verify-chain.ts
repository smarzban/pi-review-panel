/**
 * The verify chain of one review: each verify checks only what is still
 * open after the verify before it, against the diff from that verify's head.
 *
 * Every link is a complete verify record signed with the owner's record key
 * (`record.mac`, kind verify) whose signed `meta.json` names the review
 * (`priorRunId`, the meaning it always had), the link it chained from
 * (`previousRunId`: the review for the first link) and its place (`link`,
 * 1-based). A verify written before chaining has neither field; a review
 * with one cannot be chained, and is refused with "run a new review".
 *
 * The open set, the resolved round of every id and the dismissals are
 * computed from those signed bytes only. A fork (two links chained from one
 * record), a gap (a link whose parent is not a signed verify of this
 * review) or a link out of place refuses the whole chain: run a new review.
 */
import { lstatSync } from "node:fs";
import path from "node:path";

import { commitResolves, isOid } from "./commits.js";
import { discoverPriorRecords } from "./prior-records.js";
import {
	loadPriorRun,
	NEW_REVIEW_FIX,
	type PriorRun,
	resolvePriorRunId,
} from "./prior-run.js";
import { COMPLETE_MARKER, readSignedRecord } from "./record.js";
import type { StampedFinding } from "./types.js";

/** A finding kept out with the caller's reason. */
export type JudgmentRow = { id: string; reason: string };

/** A seat as roster id and lens. */
export type ChainSeat = { rosterId: string; lens: string };

/** A regression a link's seats reported, with its chain-stable id. */
export type ChainRegression = {
	/** `V<link>-R<n>`, numbered across the link's voting seats in order. */
	id: string;
	title: string;
	file: string;
	line: number;
	evidence: string;
	/** An id an earlier round marked resolved that this change undoes. */
	undoes?: string;
};

/** One verify of the chain, parsed from its signed bytes. */
export type ChainLink = {
	runId: string;
	/** 1-based place in the chain. */
	link: number;
	/** The record it chained from: the review for the first link. */
	previousRunId: string;
	headOid: string;
	keptFindingIds: string[];
	dismissed: JudgmentRow[];
	lowAdvisory: string[];
	/** Per id, every disposition a voting seat gave it. */
	dispositions: Map<string, Set<string>>;
	/**
	 * Ids every voting seat that answered marked resolved; none when the
	 * round lost a verify seat.
	 */
	resolved: Set<string>;
	/** Per resolved id, the first voting seat's evidence. */
	notes: Map<string, { file: string; explanation: string }>;
	regressions: ChainRegression[];
	/** Seats that voted. */
	seats: ChainSeat[];
	/** Seats that were lost, as `rosterId/lens`. */
	lost: string[];
};

/** Where an id stands after the chain's last link. */
export type ChainItemState =
	/** A review finding before the first verify placed it. */
	| { status: "unplaced" }
	| { status: "open"; link: number }
	| { status: "resolved"; link: number; runId: string }
	| { status: "dismissed"; link: number; reason: string }
	| { status: "low"; link: number };

/** A review finding or a regression, with where it stands. */
export type ChainItem = {
	id: string;
	title: string;
	file: string;
	line: number;
	evidence: string;
	/** A review finding's stated severity; a regression has none. */
	severity?: string;
	/** For a regression: the link that reported it, and what it undoes. */
	regression?: { link: number; undoes?: string };
	state: ChainItemState;
};

export type ChainState = {
	/** Review findings in record order, then regressions in chain order. */
	items: Map<string, ChainItem>;
	/** Ids open after the last link, in the order of `items`. */
	open: string[];
};

/** A review, its chain and the record a new verify would chain from. */
export type ChainPrior = {
	review: PriorRun;
	links: ChainLink[];
	/** The link a new verify chains from; undefined for the review itself. */
	previous?: ChainLink;
};

const REFUSED = "Verify refused";

function isRealFile(target: string): boolean {
	try {
		return lstatSync(target).isFile();
	} catch {
		return false;
	}
}

function parse(text: string | undefined): unknown {
	try {
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type VoteRow = {
	seat?: { rosterId?: unknown; lens?: unknown };
	outcome?: {
		kind?: unknown;
		result?: {
			items?: Array<{
				id?: unknown;
				disposition?: unknown;
				evidence?: { file?: unknown; explanation?: unknown };
			}>;
			regressions?: Array<{
				file?: unknown;
				line?: unknown;
				title?: unknown;
				evidence?: unknown;
				undoes?: unknown;
			}>;
		};
	};
};

function votes(outcomes: unknown): VoteRow[] {
	return Array.isArray(outcomes)
		? (outcomes as VoteRow[]).filter((row) => row?.outcome?.kind === "voted")
		: [];
}

/** Per id, every disposition a voting seat gave it. */
export function dispositionsOf(outcomes: unknown): Map<string, Set<string>> {
	const dispositions = new Map<string, Set<string>>();
	for (const row of votes(outcomes)) {
		const items = row.outcome?.result?.items;
		for (const item of Array.isArray(items) ? items : []) {
			if (
				typeof item?.id !== "string" ||
				typeof item.disposition !== "string"
			) {
				continue;
			}
			const seen = dispositions.get(item.id) ?? new Set<string>();
			seen.add(item.disposition);
			dispositions.set(item.id, seen);
		}
	}
	return dispositions;
}

/**
 * The ids a verify marked resolved: at least one voting seat answered, and
 * every answer was `resolved`.
 */
export function resolvedIdsOf(
	dispositions: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
	const resolved = new Set<string>();
	for (const [id, states] of dispositions) {
		if (states.size === 1 && states.has("resolved")) {
			resolved.add(id);
		}
	}
	return resolved;
}

/** The seats that voted, as roster id and lens; a lost seat is not one. */
export function votedSeatsOf(outcomes: unknown): ChainSeat[] {
	return votes(outcomes).flatMap((row) =>
		typeof row.seat?.rosterId === "string" && typeof row.seat.lens === "string"
			? [{ rosterId: row.seat.rosterId, lens: row.seat.lens }]
			: [],
	);
}

function lostSeatsOf(outcomes: unknown): string[] {
	if (!Array.isArray(outcomes)) {
		return [];
	}
	return (outcomes as VoteRow[]).flatMap((row) =>
		row?.outcome?.kind === "failed" &&
		typeof row.seat?.rosterId === "string" &&
		typeof row.seat.lens === "string"
			? [`${row.seat.rosterId}/${row.seat.lens}`]
			: [],
	);
}

/** The id of a link's `n`-th regression (1-based), across its seats. */
export function regressionId(link: number, n: number): string {
	return `V${link}-R${n}`;
}

/** True for an id shaped like a regression id (`V1-R2`). */
export function isRegressionId(id: string): boolean {
	return /^V[1-9]\d*-R[1-9]\d*$/u.test(id);
}

/**
 * Every regression a link's voting seats reported, in seat order then row
 * order, each with its chain-stable id `V<link>-R<n>`. The ids follow from
 * the signed outcomes' order, so they are the same wherever they are read.
 */
export function regressionsOf(
	outcomes: unknown,
	link: number,
): ChainRegression[] {
	const rows: ChainRegression[] = [];
	for (const row of votes(outcomes)) {
		const regressions = row.outcome?.result?.regressions;
		for (const regression of Array.isArray(regressions) ? regressions : []) {
			rows.push({
				id: regressionId(link, rows.length + 1),
				title: typeof regression?.title === "string" ? regression.title : "",
				file: typeof regression?.file === "string" ? regression.file : "",
				line:
					typeof regression?.line === "number" &&
					Number.isInteger(regression.line)
						? regression.line
						: 0,
				evidence:
					typeof regression?.evidence === "string" ? regression.evidence : "",
				...(typeof regression?.undoes === "string"
					? { undoes: regression.undoes }
					: {}),
			});
		}
	}
	return rows;
}

function notesOf(
	outcomes: unknown,
	resolved: ReadonlySet<string>,
): Map<string, { file: string; explanation: string }> {
	const notes = new Map<string, { file: string; explanation: string }>();
	for (const row of votes(outcomes)) {
		const items = row.outcome?.result?.items;
		for (const item of Array.isArray(items) ? items : []) {
			if (
				typeof item?.id === "string" &&
				resolved.has(item.id) &&
				!notes.has(item.id) &&
				typeof item.evidence?.file === "string" &&
				typeof item.evidence.explanation === "string"
			) {
				notes.set(item.id, {
					file: item.evidence.file,
					explanation: item.evidence.explanation,
				});
			}
		}
	}
	return notes;
}

function stringList(raw: unknown): string[] {
	return Array.isArray(raw)
		? raw.filter((item): item is string => typeof item === "string")
		: [];
}

function judgmentRows(raw: unknown): JudgmentRow[] {
	return Array.isArray(raw)
		? raw.flatMap((row) =>
				isRecord(row) &&
				typeof row.id === "string" &&
				typeof row.reason === "string"
					? [{ id: row.id, reason: row.reason }]
					: [],
			)
		: [];
}

/** What a link is made of, as a verify run or its signed record holds it. */
export type LinkParts = {
	runId: string;
	link: number;
	previousRunId: string;
	headOid: string;
	keptFindingIds: readonly string[];
	dismissed?: readonly JudgmentRow[];
	lowAdvisory?: readonly string[];
	outcomes: unknown;
};

/**
 * A link from its parts: dispositions, resolved ids, notes and regressions.
 * A round that lost any verify seat resolves nothing: its ids stay open
 * until a round with no lost seat confirms them.
 */
export function makeLink(parts: LinkParts): ChainLink {
	const dispositions = dispositionsOf(parts.outcomes);
	const lost = lostSeatsOf(parts.outcomes);
	const resolved =
		lost.length > 0 ? new Set<string>() : resolvedIdsOf(dispositions);
	return {
		runId: parts.runId,
		link: parts.link,
		previousRunId: parts.previousRunId,
		headOid: parts.headOid,
		keptFindingIds: [...parts.keptFindingIds],
		dismissed: [...(parts.dismissed ?? [])],
		lowAdvisory: [...(parts.lowAdvisory ?? [])],
		dispositions,
		resolved,
		notes: notesOf(parts.outcomes, resolved),
		regressions: regressionsOf(parts.outcomes, parts.link),
		seats: votedSeatsOf(parts.outcomes),
		lost,
	};
}

type RawLink = Omit<LinkParts, "link"> & { link?: number; legacy: boolean };

/**
 * A verify record's chain facts from its signed bytes, or undefined when its
 * signed meta or verification does not name `reviewRunId`.
 */
export function rawLinkOf(
	runId: string,
	signed: ReadonlyMap<string, string>,
	reviewRunId: string,
): RawLink | undefined {
	const meta = parse(signed.get("meta.json"));
	const verification = parse(signed.get("verification.json"));
	if (
		!isRecord(meta) ||
		!isRecord(verification) ||
		meta.kind !== "verify" ||
		meta.priorRunId !== reviewRunId ||
		verification.priorRunId !== reviewRunId
	) {
		return undefined;
	}
	return {
		runId,
		legacy: meta.link === undefined && meta.previousRunId === undefined,
		previousRunId:
			typeof meta.previousRunId === "string" ? meta.previousRunId : "",
		...(typeof meta.link === "number" && Number.isSafeInteger(meta.link)
			? { link: meta.link }
			: {}),
		headOid: typeof meta.headOid === "string" ? meta.headOid : "",
		keptFindingIds: stringList(verification.keptFindingIds),
		dismissed: judgmentRows(verification.dismissed),
		lowAdvisory: stringList(verification.lowAdvisory),
		outcomes: verification.outcomes,
	};
}

/** The owner's complete, signed verify record under this run id, or why not. */
function readVerify(
	repoDir: string,
	runId: string,
	key: Buffer,
): ReadonlyMap<string, string> {
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
	if (!isRealFile(path.join(recordPath, COMPLETE_MARKER))) {
		throw new Error(`${REFUSED}: verify run "${runId}" is not complete`);
	}
	try {
		return readSignedRecord(
			recordPath,
			"verify",
			key,
			`verify run "${runId}"`,
			NEW_REVIEW_FIX,
		);
	} catch (error) {
		throw new Error(
			`${REFUSED}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Every complete verify record of this review signed with the owner's key. */
function signedVerifiesOf(
	repoDir: string,
	reviewRunId: string,
	key: Buffer,
): RawLink[] {
	const found: RawLink[] = [];
	for (const record of discoverPriorRecords(repoDir)) {
		const runId = path.basename(record.path);
		if (!isRealFile(path.join(record.path, "verification.json"))) {
			continue;
		}
		let signed: ReadonlyMap<string, string>;
		try {
			signed = readSignedRecord(
				record.path,
				"verify",
				key,
				`verify run "${runId}"`,
				NEW_REVIEW_FIX,
			);
		} catch {
			// Not the owner's record: it is no link of any chain.
			continue;
		}
		const raw = rawLinkOf(runId, signed, reviewRunId);
		if (raw !== undefined) {
			found.push(raw);
		}
	}
	return found;
}

function broken(reviewRunId: string, why: string): Error {
	return new Error(
		`${REFUSED}: the verify chain of review "${reviewRunId}" ${why}; run a new review`,
	);
}

/**
 * The review's verify chain, first link first, from the owner's signed
 * verify records only. Refuses a verify written before rounds chained, a
 * fork, a gap and a link out of place.
 */
export function loadVerifyChain(
	repoDir: string,
	reviewRunId: string,
	key: Buffer,
): ChainLink[] {
	const all = signedVerifiesOf(repoDir, reviewRunId, key);
	const legacy = all.find((row) => row.legacy);
	if (legacy !== undefined) {
		throw new Error(
			`${REFUSED}: review "${reviewRunId}" has verify "${legacy.runId}", written before verify rounds chained; run a new review`,
		);
	}
	const children = new Map<string, RawLink[]>();
	for (const row of all) {
		const list = children.get(row.previousRunId) ?? [];
		list.push(row);
		children.set(row.previousRunId, list);
	}
	const links: ChainLink[] = [];
	let parent = reviewRunId;
	for (;;) {
		const next = children.get(parent) ?? [];
		if (next.length > 1) {
			throw broken(
				reviewRunId,
				`forks at "${parent}": ${next.map((row) => row.runId).join(", ")} all chain from it`,
			);
		}
		const current = next[0];
		if (current === undefined) {
			break;
		}
		const place = links.length + 1;
		if (current.link !== place) {
			throw broken(
				reviewRunId,
				`has verify "${current.runId}" out of place (link ${current.link ?? "missing"}, expected ${place})`,
			);
		}
		links.push(makeLink({ ...current, link: place }));
		parent = current.runId;
	}
	const inChain = new Set(links.map((row) => row.runId));
	for (const row of all) {
		if (!inChain.has(row.runId)) {
			throw broken(
				reviewRunId,
				`has a gap: verify "${row.runId}" chains from "${row.previousRunId}", which is not a complete verify of this review signed by this owner's record key`,
			);
		}
	}
	return links;
}

/** A record folder holding a verify's files and no review plan. */
function looksLikeVerify(repoDir: string, runId: string): boolean {
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
	return (
		isRealFile(path.join(recordPath, "verification.json")) &&
		!isRealFile(path.join(recordPath, "plan.json"))
	);
}

/**
 * What a new verify chains from. `priorRunId` names the review, before any
 * verify of it, or the latest verify of that review. A verify of the review
 * that is not the latest, or the review once it has a verify, is refused
 * with the latest to verify against; an unsigned record with "run a new
 * review".
 */
export function loadChainPrior(
	repoDir: string,
	priorRunId: string,
	key: Buffer,
): ChainPrior {
	const runId = resolvePriorRunId(repoDir, priorRunId);
	if (!looksLikeVerify(repoDir, runId)) {
		const review = loadPriorRun(repoDir, runId, key);
		const links = loadVerifyChain(repoDir, review.runId, key);
		const tip = links.at(-1);
		if (tip !== undefined) {
			throw new Error(
				`${REFUSED}: review "${review.runId}" has been verified already; verify against the latest verify, "${tip.runId}"`,
			);
		}
		return { review, links };
	}
	const signed = readVerify(repoDir, runId, key);
	const meta = parse(signed.get("meta.json"));
	const reviewRunId =
		isRecord(meta) && meta.kind === "verify" ? meta.priorRunId : undefined;
	if (typeof reviewRunId !== "string" || reviewRunId.trim() === "") {
		throw new Error(
			`${REFUSED}: verify run "${runId}" names no review; run a new review`,
		);
	}
	const review = loadPriorRun(repoDir, reviewRunId, key);
	const links = loadVerifyChain(repoDir, review.runId, key);
	const tip = links.at(-1);
	const previous = links.find((row) => row.runId === runId);
	if (previous === undefined || tip === undefined) {
		throw new Error(
			`${REFUSED}: verify run "${runId}" is not a link of review "${review.runId}"'s verify chain${tip === undefined ? "" : `; verify against the latest verify, "${tip.runId}"`}`,
		);
	}
	if (previous !== tip) {
		throw new Error(
			`${REFUSED}: verify run "${runId}" is not the latest verify of review "${review.runId}"; verify against the latest verify, "${tip.runId}"`,
		);
	}
	if (!isOid(previous.headOid) || !commitResolves(repoDir, previous.headOid)) {
		throw new Error(
			`${REFUSED}: verify run "${runId}" names head ${isOid(previous.headOid) ? previous.headOid : "(not a commit id)"}, which is not a commit in this repository; run a new review here`,
		);
	}
	return { review, links, previous };
}

function reviewItem(row: StampedFinding): ChainItem {
	return {
		id: row.id,
		title: row.finding.title,
		file: row.finding.file,
		line: row.finding.line,
		evidence: row.finding.evidence,
		severity: row.finding.severity,
		state: { status: "unplaced" },
	};
}

/**
 * Where every review finding and every regression stands after the chain's
 * links, in order. Per link: its dismissals and low/advisory ids (a kept id
 * stays kept), then each kept id resolved (every voting seat that answered
 * said resolved) or open, then its regressions, open.
 */
export function chainState(
	findings: readonly StampedFinding[],
	links: readonly ChainLink[],
): ChainState {
	const items = new Map<string, ChainItem>();
	for (const row of findings) {
		items.set(row.id, reviewItem(row));
	}
	const set = (id: string, state: ChainItemState) => {
		const item = items.get(id);
		if (item !== undefined) {
			item.state = state;
		}
	};
	for (const link of links) {
		const kept = new Set(link.keptFindingIds);
		for (const row of link.dismissed) {
			if (!kept.has(row.id)) {
				set(row.id, {
					status: "dismissed",
					link: link.link,
					reason: row.reason,
				});
			}
		}
		for (const id of link.lowAdvisory) {
			if (!kept.has(id)) {
				set(id, { status: "low", link: link.link });
			}
		}
		for (const id of link.keptFindingIds) {
			set(
				id,
				link.resolved.has(id)
					? { status: "resolved", link: link.link, runId: link.runId }
					: { status: "open", link: link.link },
			);
		}
		for (const regression of link.regressions) {
			items.set(regression.id, {
				id: regression.id,
				title: regression.title,
				file: regression.file,
				line: regression.line,
				evidence: regression.evidence,
				regression: {
					link: link.link,
					...(regression.undoes === undefined
						? {}
						: { undoes: regression.undoes }),
				},
				state: { status: "open", link: link.link },
			});
		}
	}
	return {
		items,
		open: [...items.values()]
			.filter((item) => item.state.status === "open")
			.map((item) => item.id),
	};
}

function stateWords(
	state: ChainItemState,
	links: readonly ChainLink[],
): string {
	const by = (link: number) => {
		const runId = links[link - 1]?.runId;
		return runId === undefined ? `link ${link}` : `verify run "${runId}"`;
	};
	switch (state.status) {
		case "resolved":
			return `was resolved by ${by(state.link)}`;
		case "dismissed":
			return `was dismissed in ${by(state.link)}`;
		case "low":
			return `was left as low/advisory in ${by(state.link)}`;
		default:
			return "is open";
	}
}

/**
 * Checks a verify's ids against the chain, before any seat runs, and
 * returns its full low/advisory list. Refused: an id the review and the
 * chain do not hold, one listed twice, a kept id also dismissed, an empty
 * reason, a high/medium finding or a regression listed as low/advisory (a
 * regression has no severity: dismiss it with a reason), and any id an
 * earlier round resolved, dismissed or left as low/advisory, which is not
 * judged again. A kept low may also be listed as low/advisory; it counts as
 * kept. The first verify places every review finding: a high or medium it
 * neither keeps, dismisses nor lists is refused, and a low it leaves out is
 * left as low/advisory (added to the list returned, so it is recorded).
 */
export function judgeRound(
	state: ChainState,
	links: readonly ChainLink[],
	keptFindingIds: readonly string[],
	dismissed: readonly JudgmentRow[],
	lowAdvisory: readonly string[],
): string[] {
	const settled = (id: string, item: ChainItem) => {
		if (item.state.status !== "open" && item.state.status !== "unplaced") {
			throw new Error(
				`${REFUSED}: ${id} ${stateWords(item.state, links)}; it is not judged again`,
			);
		}
	};
	const kept = new Set<string>();
	for (const id of keptFindingIds) {
		const item = state.items.get(id);
		if (item === undefined) {
			throw new Error(
				`${REFUSED}: kept finding "${id}" is not in the prior run`,
			);
		}
		if (kept.has(id)) {
			throw new Error(`${REFUSED}: duplicate kept finding id "${id}"`);
		}
		settled(id, item);
		kept.add(id);
	}
	const claimed = new Set(kept);
	for (const row of dismissed) {
		const item = state.items.get(row.id);
		if (item === undefined) {
			throw new Error(
				`${REFUSED}: dismissed ${row.id} is not in the review record`,
			);
		}
		if (claimed.has(row.id)) {
			throw new Error(`${REFUSED}: ${row.id} is listed more than once`);
		}
		if (row.reason.trim() === "") {
			throw new Error(`${REFUSED}: dismissed ${row.id} needs a reason`);
		}
		settled(row.id, item);
		claimed.add(row.id);
	}
	for (const id of lowAdvisory) {
		const item = state.items.get(id);
		if (item === undefined) {
			throw new Error(
				`${REFUSED}: low/advisory ${id} is not in the review record`,
			);
		}
		if (item.regression !== undefined) {
			throw new Error(
				`${REFUSED}: ${id} is a regression, which has no severity; dismiss it with a reason instead`,
			);
		}
		if (kept.has(id)) {
			if (item.severity !== "low") {
				throw new Error(
					`${REFUSED}: ${id} is ${item.severity} and kept; only a low finding can also be listed as low/advisory`,
				);
			}
			// A kept low counts as kept; listing it here as well is harmless.
			continue;
		}
		if (claimed.has(id)) {
			throw new Error(`${REFUSED}: ${id} is listed more than once`);
		}
		if (item.severity !== "low") {
			throw new Error(
				`${REFUSED}: ${id} is ${item.severity}; a high/medium finding that is not kept must be dismissed with a reason`,
			);
		}
		settled(id, item);
		claimed.add(id);
	}
	const unplaced = [...state.items.values()].filter(
		(item) => item.state.status === "unplaced" && !claimed.has(item.id),
	);
	const missing = unplaced
		.filter((item) => item.severity !== "low")
		.map((item) => item.id);
	if (missing.length > 0) {
		throw new Error(
			`${REFUSED}: the first verify places every finding: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not kept, dismissed or left as low/advisory`,
		);
	}
	return [...lowAdvisory, ...unplaced.map((item) => item.id)];
}

/**
 * The ids a verify checks when the caller names none: every id open after
 * the chain's last link, less what the caller dismisses or leaves as
 * low/advisory now. The first verify of a review has nothing open yet, so
 * it needs the caller's kept ids.
 */
export function defaultKeptIds(
	prior: ChainPrior,
	state: ChainState,
	dismissed: readonly JudgmentRow[],
	lowAdvisory: readonly string[],
): string[] {
	if (prior.previous === undefined) {
		throw new Error(
			`${REFUSED}: keptFindingIds is required for the first verify of a review (pass "" for none)`,
		);
	}
	const out = new Set([...dismissed.map((row) => row.id), ...lowAdvisory]);
	return state.open.filter((id) => !out.has(id));
}
