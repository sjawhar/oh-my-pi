import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { type CaseFile, type RunRecord, clusterBootstrap, detects, gradeRuns, loadRuns } from "./grade.ts";
import {
	type RoundRun,
	type Sequence,
	detectedBySequence,
	firstRoundDetected,
	fisherExact,
	pairedCompare,
	roundsInScope,
	scoreArms,
	scoreClass,
	toSequences,
} from "./rounds.ts";
import { type RoundRecord, roundSuffix, scratchListing } from "./run-rounds.ts";

const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "cases.json"), "utf8")) as CaseFile;
const freeze = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "rounds-freeze.json"), "utf8")) as {
	symlink_class: { finding_ids: string[] };
};
const firstEvalRuns = path.join(import.meta.dir, "runs", "2026-10-30");

function run(partial: Partial<RoundRun> & { runId: string; report: string }): RoundRun {
	return {
		arm: "rounds-carry",
		head: "pr17394-r7",
		trial: 1,
		model: "anthropic/claude-opus-5-5",
		costUsd: 1,
		elapsedMs: 1000,
		exitCode: 0,
		...partial,
	};
}

describe("toSequences", () => {
	test("groups rounds of one sequence in round order", () => {
		const seqs = toSequences([
			run({ runId: "a__r3", sequence: "a", round: 3, report: "three" }),
			run({ runId: "a__r1", sequence: "a", round: 1, report: "one" }),
			run({ runId: "a__r2", sequence: "a", round: 2, report: "two" }),
		]);
		expect(seqs).toHaveLength(1);
		expect(seqs[0]?.rounds.map(r => r.round)).toEqual([1, 2, 3]);
		expect(seqs[0]?.costUsd).toBe(3);
	});

	test("a run without a sequence field is its own one-round sequence", () => {
		const seqs = toSequences([run({ runId: "solo-1", report: "x" }), run({ runId: "solo-2", report: "y" })]);
		expect(seqs.map(s => s.id)).toEqual(["solo-1", "solo-2"]);
		expect(seqs.every(s => s.rounds.length === 1)).toBe(true);
	});

	test("an errored or empty round is dropped from the sequence and counted", () => {
		const seqs = toSequences([
			run({ runId: "a__r1", sequence: "a", round: 1, report: "one" }),
			run({ runId: "a__r2", sequence: "a", round: 2, report: "frag", error: "spend cap reached" }),
			run({ runId: "a__r3", sequence: "a", round: 3, report: "   " }),
		]);
		expect(seqs[0]?.rounds.map(r => r.round)).toEqual([1]);
		expect(seqs[0]?.failedRounds).toBe(2);
	});
});

describe("scopes", () => {
	const seq = toSequences([
		run({ runId: "a__r1", sequence: "a", round: 1, report: "one" }),
		run({ runId: "a__r2", sequence: "a", round: 2, report: "two" }),
		run({ runId: "a__r3", sequence: "a", round: 3, report: "three" }),
	])[0] as Sequence;

	test("union is every round, final is the last, first is round one", () => {
		expect(roundsInScope(seq, "union").map(r => r.round)).toEqual([1, 2, 3]);
		expect(roundsInScope(seq, "final").map(r => r.round)).toEqual([3]);
		expect(roundsInScope(seq, "first").map(r => r.round)).toEqual([1]);
	});

	test("final is the last usable round, not the last attempted", () => {
		const withFailedTail = toSequences([
			run({ runId: "b__r1", sequence: "b", round: 1, report: "one" }),
			run({ runId: "b__r2", sequence: "b", round: 2, report: "two" }),
			run({ runId: "b__r3", sequence: "b", round: 3, report: "", error: "empty report" }),
		])[0] as Sequence;
		expect(roundsInScope(withFailedTail, "final").map(r => r.round)).toEqual([2]);
	});
});

describe("detection is the frozen rule, composed over rounds", () => {
	// A real finding and a report that satisfies it, taken from the frozen case
	// file so the test exercises `detects` rather than a stub.
	const finding = cases.findings.find(f => f.id === "17394-R7-5");
	const hitReport =
		"Reaching the same worktree root through a symlink produces a different abstract socket lock name, so two sessions take two different locks for one directory.";

	test("the chosen fixture satisfies the frozen rule on its own", () => {
		expect(finding).toBeDefined();
		expect(detects(hitReport, finding as never, cases.window_chars)).toBe(true);
	});

	test("a hit in any round is a union hit; a miss in all is a miss", () => {
		const hitAtTwo = toSequences([
			run({ runId: "c__r1", sequence: "c", round: 1, report: "nothing relevant here" }),
			run({ runId: "c__r2", sequence: "c", round: 2, report: hitReport }),
		])[0] as Sequence;
		expect(detectedBySequence(hitAtTwo, finding as never, cases.window_chars, "union")).toBe(true);
		expect(detectedBySequence(hitAtTwo, finding as never, cases.window_chars, "first")).toBe(false);
		expect(detectedBySequence(hitAtTwo, finding as never, cases.window_chars, "final")).toBe(true);
		expect(firstRoundDetected(hitAtTwo, finding as never, cases.window_chars)).toBe(2);
	});

	test("a finding found in round 1 and dropped later still counts for the union", () => {
		const foundThenDropped = toSequences([
			run({ runId: "d__r1", sequence: "d", round: 1, report: hitReport }),
			run({ runId: "d__r2", sequence: "d", round: 2, report: "nothing relevant here" }),
		])[0] as Sequence;
		expect(detectedBySequence(foundThenDropped, finding as never, cases.window_chars, "union")).toBe(true);
		expect(detectedBySequence(foundThenDropped, finding as never, cases.window_chars, "final")).toBe(false);
		expect(firstRoundDetected(foundThenDropped, finding as never, cases.window_chars)).toBe(1);
	});
});

describe("scoreArms agrees with the frozen grader on one-round arms", () => {
	const runs = loadRuns(firstEvalRuns) as RoundRun[];
	const byArmFromGrade = new Map(gradeRuns(cases, runs as RunRecord[]).map(r => [r.arm, r]));
	const scores = scoreArms(cases, toSequences(runs), "union");

	test("the first eval's four arms are all present", () => {
		expect(scores.map(s => s.arm).sort()).toEqual(["candidate", "control", "crossfamily", "current"]);
	});

	for (const arm of ["candidate", "control", "crossfamily", "current"]) {
		test(`${arm}: same n, same detected, same rate, same bootstrap`, () => {
			const a = byArmFromGrade.get(arm);
			const b = scores.find(s => s.arm === arm);
			expect(b?.n).toBe(a?.n as number);
			expect(b?.detected).toBe(a?.detected as number);
			expect(b?.rate).toBeCloseTo(a?.rate as number, 12);
			expect(b?.bootstrap.lo).toBeCloseTo(a?.bootstrap.lo as number, 12);
			expect(b?.bootstrap.hi).toBeCloseTo(a?.bootstrap.hi as number, 12);
		});
	}

	test("a sequence with no usable round is excluded from n, never scored zero", () => {
		const withDead = toSequences([
			...runs,
			run({ runId: "dead", arm: "control", head: "pr17394-r7", report: "", error: "empty report" }),
		]);
		const s = scoreArms(cases, withDead, "union").find(x => x.arm === "control");
		expect(s?.n).toBe(byArmFromGrade.get("control")?.n as number);
		expect(s?.failedRounds).toBe(1);
	});
});

describe("paired bootstrap", () => {
	const sequences = toSequences(loadRuns(firstEvalRuns) as RoundRun[]);

	test("reproduces the first eval's published candidate − control comparison", () => {
		const r = pairedCompare(cases, sequences, "candidate", "control", "union");
		expect(r.pairs).toBe(6);
		expect(r.deltaPp).toBeCloseTo(-3.3, 1);
		expect(r.aWins).toBe(2);
		expect(r.bWins).toBe(2);
		expect(r.ties).toBe(2);
		expect(r.lo).toBeLessThan(0);
		expect(r.hi).toBeGreaterThan(0);
	});

	test("reproduces the first eval's published crossfamily − control delta", () => {
		const r = pairedCompare(cases, sequences, "crossfamily", "control", "union");
		expect(r.deltaPp).toBeCloseTo(11.7, 1);
	});

	test("an arm compared with itself is exactly zero with a zero-width interval", () => {
		const r = pairedCompare(cases, sequences, "control", "control", "union");
		expect(r.deltaPp).toBe(0);
		expect(r.lo).toBe(0);
		expect(r.hi).toBe(0);
	});

	test("the PRNG matches the frozen grader's, so intervals are reproducible", () => {
		const a = clusterBootstrap([
			{ successes: 3, n: 10 },
			{ successes: 5, n: 10 },
		]);
		const b = clusterBootstrap([
			{ successes: 3, n: 10 },
			{ successes: 5, n: 10 },
		]);
		expect(a).toEqual(b);
		const self = pairedCompare(cases, sequences, "candidate", "candidate", "union");
		expect(self.deltaPp).toBe(0);
	});
});

describe("fisherExact", () => {
	test("reproduces the first eval's symlink-class p value", () => {
		expect(fisherExact(3, 3, 0, 18)).toBeCloseTo(0.0099, 4);
	});

	test("a textbook table", () => {
		// Fisher's tea taster: 3 of 4 correct each way.
		expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 4);
	});

	test("no difference gives p = 1", () => {
		expect(fisherExact(5, 5, 5, 5)).toBeCloseTo(1, 10);
	});

	test("an empty row gives p = 1 rather than NaN", () => {
		expect(fisherExact(0, 0, 3, 7)).toBe(1);
	});
});

describe("scoreClass", () => {
	const sequences = toSequences(loadRuns(firstEvalRuns) as RoundRun[]);
	const ids = freeze.symlink_class.finding_ids;

	test("the frozen class reproduces the first eval's 0 of 18 against 3 of 6", () => {
		const cls = scoreClass(cases, sequences, ids, "union");
		const same = cls.filter(c => c.arm === "candidate" || c.arm === "control" || c.arm === "current");
		const cross = cls.find(c => c.arm === "crossfamily");
		expect(same.reduce((a, c) => a + c.pairs, 0)).toBe(18);
		expect(same.reduce((a, c) => a + c.hits, 0)).toBe(0);
		expect(cross?.pairs).toBe(6);
		expect(cross?.hits).toBe(3);
	});

	test("only heads that carry a class finding contribute", () => {
		const cls = scoreClass(cases, sequences, ids, "union");
		// pr17399-r3 has no symlink finding, so each arm contributes 4 sequences
		// of its 6, two heads x two trials.
		expect(cls.every(c => c.sequences === 4)).toBe(true);
	});
});

describe("round prompt rendering", () => {
	const freezeFile = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "rounds-freeze.json"), "utf8")) as {
		round_prompt_templates: Record<string, string>;
	};
	const templates = freezeFile.round_prompt_templates;
	const prior: RoundRecord[] = [
		{
			...run({ runId: "s__r1", sequence: "s", round: 1, report: "FINDING ONE TEXT" }),
			sequence: "s",
			round: 1,
			rounds: 3,
			promptChars: 10,
		},
		{
			...run({ runId: "s__r2", sequence: "s", round: 2, report: "FINDING TWO TEXT" }),
			sequence: "s",
			round: 2,
			rounds: 3,
			promptChars: 10,
		},
	];

	test("the blind template carries the expectation and no earlier content", () => {
		const text = roundSuffix(templates["retry-blind"] as string, 3, 3, "/does/not/exist", prior);
		expect(text).toContain("attempt 3 of 3");
		expect(text).toContain("2 earlier attempt");
		expect(text).not.toContain("FINDING ONE TEXT");
		expect(text).not.toContain("FINDING TWO TEXT");
		expect(text).not.toContain("{");
	});

	test("the carry template reproduces every earlier report verbatim", () => {
		const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rounds-scratch-"));
		fs.writeFileSync(path.join(dir, "probe.test.ts"), "x");
		fs.mkdirSync(path.join(dir, "bun-cache"));
		fs.writeFileSync(path.join(dir, "bun-cache", "junk"), "y");
		const text = roundSuffix(templates["rounds-carry"] as string, 3, 3, dir, prior);
		expect(text).toContain("round 3 of 3");
		expect(text).toContain("Rounds 1 to 2");
		expect(text).toContain("FINDING ONE TEXT");
		expect(text).toContain("FINDING TWO TEXT");
		expect(text).toContain("===== round 1 report =====");
		expect(text).toContain("===== end of round 2 report =====");
		expect(text).toContain("probe.test.ts (1 bytes)");
		expect(text).not.toContain("bun-cache");
		expect(text).not.toContain("{");
		fs.rmSync(dir, { recursive: true });
	});

	test("an empty scratch directory says so rather than rendering a placeholder", () => {
		const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rounds-empty-"));
		expect(scratchListing(dir)).toBe("  (nothing yet)");
		fs.rmSync(dir, { recursive: true });
	});
});
