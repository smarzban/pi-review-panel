import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyAgentDir,
	chooseAgentDir,
	describeAgentDir,
} from "../src/agent-dir.js";

function home(files: string[] = []): string {
	const dir = mkdtempSync(path.join(tmpdir(), "rp-home-"));
	for (const file of files) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), "{}");
	}
	return dir;
}

describe("chooseAgentDir", () => {
	it("uses PI_CODING_AGENT_DIR when it is set, even when ~/.pi/agent has a login", () => {
		const h = home([".pi/agent/auth.json"]);
		expect(
			chooseAgentDir({ env: { PI_CODING_AGENT_DIR: "/srv/agent" }, home: h }),
		).toEqual({ dir: "/srv/agent", source: "environment" });
	});

	it("expands a leading ~ in PI_CODING_AGENT_DIR as Pi does", () => {
		const h = home();
		expect(
			chooseAgentDir({ env: { PI_CODING_AGENT_DIR: "~/agent" }, home: h }).dir,
		).toBe(path.join(h, "agent"));
	});

	it("treats an empty PI_CODING_AGENT_DIR as unset, as Pi does", () => {
		const h = home();
		expect(
			chooseAgentDir({ env: { PI_CODING_AGENT_DIR: "" }, home: h }).source,
		).toBe("review-panel");
	});

	it("reuses ~/.pi/agent when it holds auth.json", () => {
		const h = home([".pi/agent/auth.json"]);
		expect(chooseAgentDir({ env: {}, home: h })).toEqual({
			dir: path.join(h, ".pi", "agent"),
			source: "pi",
		});
	});

	it("reuses ~/.pi/agent when it holds only models.json", () => {
		const h = home([".pi/agent/models.json"]);
		expect(chooseAgentDir({ env: {}, home: h }).source).toBe("pi");
	});

	it("does not count a ~/.pi/agent folder without auth.json or models.json as a Pi install", () => {
		const h = home([".pi/agent/settings.json"]);
		expect(chooseAgentDir({ env: {}, home: h })).toEqual({
			dir: path.join(h, ".pi-review-panel", "agent"),
			source: "review-panel",
		});
	});
});

describe("applyAgentDir", () => {
	it("pins the choice in the environment before the SDK loads", () => {
		const h = home();
		const env: Record<string, string | undefined> = {};
		const choice = applyAgentDir({ env, home: h });
		expect(env.PI_CODING_AGENT_DIR).toBe(
			path.join(h, ".pi-review-panel", "agent"),
		);
		expect(describeAgentDir(choice)).toContain("review-panel's own folder");
	});

	it("writes the expanded path back, so later readers need no ~ handling", () => {
		const h = home();
		const env: Record<string, string | undefined> = {
			PI_CODING_AGENT_DIR: "~/x",
		};
		applyAgentDir({ env, home: h });
		expect(env.PI_CODING_AGENT_DIR).toBe(path.join(h, "x"));
	});
});
