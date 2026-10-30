import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type CaseFile, type Finding, type RunRecord, clusterBootstrap, detects, gradeRuns, wilson } from "./grade.ts";

const finding: Finding = {
	id: "T-1",
	head: "h1",
	severity: "P1",
	how_found_primary: "write-probe",
	title: "test",
	mechanism: [["symlink", "symbolic link"], ["clear"], ["delet", "remov"]],
	trigger: [["under.?lock", "TOCTOU"]],
};

describe("detects", () => {
	test("all groups inside one window", () => {
		const report = "The clear path takes the lock, then a symlink swap under lock makes it delete a live sandbox.";
		expect(detects(report, finding, 1200)).toBe(true);
	});

	test("a missing group fails even when every other group matches", () => {
		const report = "The clear path takes the lock, then a symlink swap makes it delete a live sandbox.";
		expect(detects(report, finding, 1200)).toBe(false);
	});

	test("groups scattered beyond the window do not count", () => {
		const filler = "x".repeat(4000);
		const report = `symlink ${filler} clear delete under lock`;
		expect(detects(report, finding, 200)).toBe(false);
		expect(detects(report, finding, 12000)).toBe(true);
	});

	test("matching is case-insensitive", () => {
		expect(detects("SYMLINK CLEAR DELETE UNDER-LOCK", finding, 1200)).toBe(true);
	});

	test("a zero-width-capable pattern terminates", () => {
		const f: Finding = { ...finding, mechanism: [["a*"]], trigger: [["b"]] };
		expect(detects("aaab", f, 100)).toBe(true);
	});
});

describe("wilson", () => {
	test("n = 0 is the whole interval", () => {
		expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
	});

	test("bounds stay inside [0, 1] at the extremes", () => {
		const all = wilson(10, 10);
		expect(all.lo).toBeGreaterThan(0.6);
		expect(all.hi).toBeCloseTo(1, 10);
		const none = wilson(0, 10);
		expect(none.lo).toBe(0);
		expect(none.hi).toBeLessThan(0.35);
	});

	test("a wider sample gives a narrower interval at the same rate", () => {
		const small = wilson(5, 10);
		const large = wilson(50, 100);
		expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
	});
});

describe("clusterBootstrap", () => {
	test("is deterministic for one seed", () => {
		const clusters = [
			{ successes: 3, n: 9 },
			{ successes: 1, n: 7 },
			{ successes: 5, n: 14 },
		];
		expect(clusterBootstrap(clusters, 2000)).toEqual(clusterBootstrap(clusters, 2000));
	});

	test("covers the observed rate", () => {
		const clusters = [
			{ successes: 2, n: 10 },
			{ successes: 3, n: 10 },
			{ successes: 1, n: 10 },
		];
		const ci = clusterBootstrap(clusters, 4000);
		expect(ci.lo).toBeLessThanOrEqual(0.2);
		expect(ci.hi).toBeGreaterThanOrEqual(0.2);
	});

	test("no clusters is the whole interval", () => {
		expect(clusterBootstrap([], 100)).toEqual({ lo: 0, hi: 1 });
	});
});

const cases: CaseFile = {
	frozen_at: "2026-10-30T06:05:00Z",
	window_chars: 1200,
	heads: [
		{
			id: "h1",
			pr: 1,
			round: 1,
			head_sha: "abc",
			base_sha: "def",
			checkout: "/tmp/x",
			diff: "/tmp/x.diff",
			subject: "s",
			packages: ["packages/coding-agent"],
		},
	],
	findings: [finding, { ...finding, id: "T-2", mechanism: [["never-present-token"]], trigger: [["x"]] }],
};

function run(arm: string, report: string, error?: string): RunRecord {
	return {
		runId: `${arm}__h1__t1`,
		arm,
		head: "h1",
		trial: 1,
		model: "m",
		report,
		costUsd: 1,
		elapsedMs: 1,
		exitCode: 0,
		...(error === undefined ? {} : { error }),
	};
}

describe("gradeRuns", () => {
	test("counts one detection out of two findings", () => {
		const [result] = gradeRuns(cases, [run("candidate", "symlink swap under lock: clear will delete it")]);
		expect(result?.n).toBe(2);
		expect(result?.detected).toBe(1);
		expect(result?.perFinding["T-1"]).toEqual({ n: 1, detected: 1 });
		expect(result?.perFinding["T-2"]).toEqual({ n: 1, detected: 0 });
	});

	test("an errored run is excluded from n, not scored as zero", () => {
		const [result] = gradeRuns(cases, [run("candidate", "symlink swap under lock: clear will delete it"), run("candidate", "", "provider error")]);
		expect(result?.runs).toBe(1);
		expect(result?.n).toBe(2);
		expect(result?.failedRuns).toBe(1);
	});

	test("an empty report is treated as an error, not a score", () => {
		const [result] = gradeRuns(cases, [run("control", "   ")]);
		expect(result?.runs).toBe(0);
		expect(result?.n).toBe(0);
		expect(result?.failedRuns).toBe(1);
	});
});

describe("cases.json", () => {
	const file = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "cases.json"), "utf8")) as CaseFile;

	test("every finding names a declared head", () => {
		const ids = new Set(file.heads.map((h) => h.id));
		for (const f of file.findings) expect(ids.has(f.head)).toBe(true);
	});

	test("finding ids are unique", () => {
		expect(new Set(file.findings.map((f) => f.id)).size).toBe(file.findings.length);
	});

	test("every pattern compiles and no group is empty", () => {
		for (const f of file.findings) {
			expect(f.mechanism.length + f.trigger.length).toBeGreaterThan(1);
			for (const group of [...f.mechanism, ...f.trigger]) {
				expect(group.length).toBeGreaterThan(0);
				for (const pattern of group) expect(() => new RegExp(pattern, "gi")).not.toThrow();
			}
		}
	});

	test("no spec fires on a sibling finding's text at the same head", () => {
		// The false positive that would matter is a spec so generic that a
		// reviewer writing about a different defect in the same patch scores it.
		const filler = "\u0000".repeat(5000);
		for (const f of file.findings) {
			const distractors = file.findings
				.filter((o) => o.head === f.head && o.id !== f.id)
				.map((o) => o.title)
				.join(filler);
			if (!detects(distractors, f, file.window_chars)) continue;
			throw new Error(`spec for ${f.id} fires on a sibling finding's title`);
		}
	});

	test("no spec fires on generic review prose", () => {
		const prose = [
			"This change looks reasonable overall. The new helper is covered by tests and the",
			"error handling follows the surrounding code. Consider adding a comment that explains",
			"why the lock is taken before the directory is created, and renaming the variable for",
			"clarity. I did not find a blocking issue; the diff is well scoped and the behaviour",
			"it changes is exercised by the existing suite.",
		].join(" ");
		for (const f of file.findings) {
			if (!detects(prose, f, file.window_chars)) continue;
			throw new Error(`spec for ${f.id} fires on generic prose`);
		}
	});
});
