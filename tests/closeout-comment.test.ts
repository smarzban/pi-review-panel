import { describe, expect, it } from "vitest";

import type { PanelRecord, StampedFinding } from "../src/run/types.js";
import {
	assembleCloseoutComment,
	renderCloseoutComment,
} from "../src/tool/closeout-comment.js";

const baseOid = "a1b2c3dffffffffeeeeeeeeeeeeeeeeeeeeeee";
const headOid = "e4f5a6bffffffffeeeeeeeeeeeeeeeeeeeeeee";

function finding(
	id: string,
	severity: "high" | "medium" | "low",
	title: string,
): StampedFinding {
	return {
		id,
		seat: {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: "holistic",
		},
		finding: {
			file: "src/a.ts",
			line: 1,
			severity,
			title,
			evidence: "evidence",
		},
	};
}

const panel: PanelRecord = {
	runId: "run-1",
	baseRef: "origin/main",
	seats: [
		{
			rosterId: "terra",
			lens: "holistic",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		{
			rosterId: "glm",
			lens: "holistic",
			provider: "ollama",
			model: "glm-5.2",
		},
		{
			rosterId: "deepseek",
			lens: "holistic",
			provider: "qwen-token-plan",
			model: "deepseek-v4-flash-0731",
		},
		{
			rosterId: "terra",
			lens: "security",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		{
			rosterId: "glm",
			lens: "security",
			provider: "ollama",
			model: "glm-5.2",
		},
		{
			rosterId: "terra",
			lens: "tests",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		{
			rosterId: "glm",
			lens: "tests",
			provider: "ollama",
			model: "glm-5.2",
		},
	],
};

describe("renderCloseoutComment", () => {
	it("renders the agreed close-out card", () => {
		const text = renderCloseoutComment({
			submitted: 10,
			fixed: 6,
			dismissed: [
				{
					id: "F-4",
					title: "stale cache claim",
					reason: "the cache key includes the tenant",
				},
				{
					id: "F-5",
					title: "auth header optional",
					reason: "the handler still rejects a missing token",
				},
			],
			lowAdvisory: [
				{ id: "F-8", title: "rename the helper" },
				{ id: "F-9", title: "extra log line" },
			],
			seats: ["terra", "glm", "deepseek"],
			extras: ["security", "tests"],
			lost: [],
			baseRef: "origin/main",
			baseOid,
			headOid,
		});

		expect(text).toBe(
			[
				"## Review panel",
				"",
				"10 findings submitted · 6 fixed · 2 dismissed · 2 left as low/advisory",
				"Seats: terra, glm, deepseek (holistic) · extras: security, tests",
				"Lost: none",
				"`origin/main` (`a1b2c3d`) → `HEAD` (`e4f5a6b`)",
				"",
				"### Dismissed",
				"- F-4 stale cache claim — the cache key includes the tenant",
				"- F-5 auth header optional — the handler still rejects a missing token",
				"",
				"### Low / advisory (not kept)",
				"- F-8 rename the helper",
				"- F-9 extra log line",
			].join("\n"),
		);
	});

	it("omits empty dismissed and low sections and the extras clause", () => {
		const text = renderCloseoutComment({
			submitted: 0,
			fixed: 0,
			dismissed: [],
			lowAdvisory: [],
			seats: ["terra"],
			extras: [],
			lost: [],
			baseRef: "main",
			baseOid,
			headRef: "feat/x",
			headOid,
		});

		expect(text).toBe(
			[
				"## Review panel",
				"",
				"0 findings submitted · 0 fixed · 0 dismissed · 0 left as low/advisory",
				"Seats: terra (holistic)",
				"Lost: none",
				"`main` (`a1b2c3d`) → `feat/x` (`e4f5a6b`)",
			].join("\n"),
		);
		expect(text).not.toContain("### Dismissed");
		expect(text).not.toContain("### Low / advisory");
		expect(text).not.toContain("extras:");
	});

	it("lists lost coverage and never adds a Fixed list or merge claim", () => {
		const text = renderCloseoutComment({
			submitted: 1,
			fixed: 1,
			dismissed: [],
			lowAdvisory: [],
			seats: ["terra", "glm"],
			extras: ["security"],
			lost: ["deepseek/holistic"],
			baseRef: "origin/main",
			baseOid,
			headOid,
		});

		expect(text).toContain("Lost: deepseek/holistic");
		expect(text).toContain("1 finding submitted · 1 fixed");
		expect(text).not.toContain("### Fixed");
		expect(text).not.toContain("Record:");
		expect(text).not.toContain("Not a merge decision");
		expect(text).not.toMatch(/<!--/);
		expect(text).not.toMatch(/ready to merge/i);
		expect(text).not.toMatch(/ready for merge/i);
		expect(text).not.toMatch(/\bverdict\b/i);
		expect(text).not.toMatch(/\brisk\b/i);
	});

	it("refuses a dismissed row without a reason", () => {
		expect(() =>
			renderCloseoutComment({
				submitted: 1,
				fixed: 0,
				dismissed: [{ id: "F-1", title: "auth bypass", reason: "   " }],
				lowAdvisory: [],
				seats: ["terra"],
				extras: [],
				lost: [],
				baseRef: "main",
				baseOid,
				headOid,
			}),
		).toThrow(/dismissed F-1 needs a reason/);
	});
});

describe("assembleCloseoutComment", () => {
	const findings = [
		finding("F-1", "high", "auth bypass"),
		finding("F-2", "medium", "missing timeout"),
		finding("F-3", "low", "rename helper"),
		finding("F-4", "high", "stale cache claim"),
	];

	it("counts remaining findings as fixed and copies titles from the run", () => {
		const text = assembleCloseoutComment({
			findings,
			panel,
			lost: [],
			meta: { baseRef: "origin/main", baseOid, headOid },
			dismissed: [{ id: "F-4", reason: "the cache key includes the tenant" }],
			lowAdvisory: ["F-3"],
		});

		expect(text).toContain(
			"4 findings submitted · 2 fixed · 1 dismissed · 1 left as low/advisory",
		);
		expect(text).toContain(
			"Seats: terra, glm, deepseek (holistic) · extras: security, tests",
		);
		expect(text).toContain(
			"- F-4 stale cache claim — the cache key includes the tenant",
		);
		expect(text).toContain("- F-3 rename helper");
		expect(text).not.toContain("### Fixed");
		expect(text).not.toContain("F-1");
		expect(text).not.toContain("F-2");
	});

	it("requires leftover lows to be listed and keeps high/medium out of that list", () => {
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [
					{ id: "F-1", reason: "checked" },
					{ id: "F-2", reason: "checked" },
					{ id: "F-4", reason: "checked" },
				],
				lowAdvisory: [],
			}),
		).toThrow(/F-3/);
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [{ id: "F-1", reason: "checked, not real" }],
				lowAdvisory: ["F-2", "F-3"],
			}),
		).toThrow(/low\/advisory/);
	});

	it("refuses unknown, overlapping, or duplicate judgment ids", () => {
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [{ id: "F-99", reason: "nope" }],
				lowAdvisory: [],
			}),
		).toThrow(/F-99/);
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [{ id: "F-3", reason: "not a nit" }],
				lowAdvisory: ["F-3"],
			}),
		).toThrow(/F-3/);
	});
});
