import { describe, expect, it } from "vitest";
import {
	MAX_AUDIT_SEATS,
	resolveAuditPanel,
} from "../src/config/audit-panel.js";
import {
	AUDIT_DEFAULT_PASSES,
	AUDIT_PASSES,
	loadAuditPassTable,
} from "../src/config/audit-passes.js";
import type { Config } from "../src/config/schema.js";

const config: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
		{ id: "glm", provider: "ollama", model: "glm-5.2" },
	],
	defaults: { seats: ["terra", "claude", "glm"] },
};

function passTable(): Map<string, string> {
	return new Map(AUDIT_PASSES.map((pass) => [pass, `PROMPT_${pass}`]));
}

describe("resolveAuditPanel", () => {
	it("plans the four baseline passes across the first two owner-default seats", () => {
		const panel = resolveAuditPanel({ config, passTable: passTable() });

		expect(AUDIT_DEFAULT_PASSES).toEqual([
			"code-health",
			"over-engineering",
			"tests",
			"security",
		]);
		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			["code-health", "terra"],
			["code-health", "claude"],
			["over-engineering", "terra"],
			["over-engineering", "claude"],
			["tests", "terra"],
			["tests", "claude"],
			["security", "terra"],
			["security", "claude"],
		]);
	});

	it("uses only explicitly selected menu passes and roster seats", () => {
		const panel = resolveAuditPanel({
			config,
			passTable: passTable(),
			passes: ["security", "ux"],
			seats: ["glm"],
		});

		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			["security", "glm"],
			["ux", "glm"],
		]);
	});

	it("refuses unknown passes and more than three explicitly selected seats", () => {
		expect(() =>
			resolveAuditPanel({
				config,
				passTable: passTable(),
				passes: ["decide"],
			}),
		).toThrow(/unknown audit pass "decide"/i);
		expect(() =>
			resolveAuditPanel({
				config,
				passTable: passTable(),
				seats: ["terra", "claude", "glm", "terra"],
			}),
		).toThrow(/at most 3/i);
		expect(MAX_AUDIT_SEATS).toBe(24);
	});
});

describe("audit pass prompt registry", () => {
	it("loads package-owned prompt bytes without a trailing newline", () => {
		const table = loadAuditPassTable();
		expect([...table.keys()]).toEqual([...AUDIT_PASSES]);
		for (const pass of AUDIT_PASSES) {
			expect(table.get(pass)).toContain(pass);
			expect(table.get(pass)?.endsWith("\n")).toBe(false);
		}
	});
});
