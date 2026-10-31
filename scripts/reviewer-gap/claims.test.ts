import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BuiltCases,
	type CorpusDecoy,
	type CorpusDefect,
	anchored,
	decoyEligible,
	headId,
	loadClaimsCorpus,
} from "./claims-build.ts";
import {
	ARM_LABELS,
	type ClaimsCaseFile,
	DECOY_CLASSES,
	asPatterns,
	claimedSections,
	compareClaims,
	gradeClaims,
	isDefectHeading,
	isFormatted,
	promptSatisfies,
	scoreRun,
} from "./claims.ts";
import { HOW_FOUND } from "./corpus.ts";
import { type Finding, type HeadCase, type RunRecord, detects } from "./grade.ts";
import { preflight, userPrompt } from "./run.ts";

const head: HeadCase = {
	id: "h1",
	pr: 1,
	round: 1,
	head_sha: "a".repeat(40),
	base_sha: "b".repeat(40),
	checkout: "/nonexistent/snapshot",
	diff: "/nonexistent/patch.diff",
	subject: "s",
	packages: ["packages/x"],
};

const cases: ClaimsCaseFile = {
	frozen_at: "t",
	window_chars: 1200,
	report_format: "claims",
	heads: [head],
	findings: [
		{
			id: "D-1",
			head: "h1",
			severity: "P1",
			how_found_primary: "write-probe",
			title: "symlink restore record overwritten",
			mechanism: [
				["restore record", "\\.restoring"],
				["symlink", "symbolic link"],
			],
			trigger: [["overwrit", "clobber"]],
			found_by: { astra: "missed", claude: "found" },
		},
		{
			id: "D-2",
			head: "h1",
			severity: "P2",
			how_found_primary: "inject-fault",
			title: "fifo hangs inside the gc lock",
			mechanism: [["fifo", "named pipe"], ["gc lock"]],
			trigger: [["hang", "blocks forever"]],
			found_by: { astra: "found", claude: "missed" },
		},
	],
	decoys: [
		{
			id: "F-1",
			head: "h1",
			title: "autocomplete disposer runs after the session",
			decoy_class: "harness-invented",
			refuted_by: "code-fact",
			mechanism: [["addAutocompleteProvider", "autocomplete"], ["dispos"]],
			trigger: [["after the session", "after dispose"]],
		},
	],
};

function run(report: string, over: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "current__h1__t1",
		arm: "current",
		head: "h1",
		trial: 1,
		model: "m",
		report,
		costUsd: 1,
		elapsedMs: 1,
		exitCode: 0,
		...over,
	};
}

describe("isDefectHeading", () => {
	test.each([
		["DEFECT: x", true],
		["DEFECT 2: x", true],
		["**DEFECT** - x", true],
		["Defect: lowercase still counts", true],
		["DEFECTS", false],
		["Defects found", false],
		["Defect status of round 27", false],
		["NOT A DEFECT", false],
		["No defect here", false],
	])("%s -> %s", (text, want) => {
		expect(isDefectHeading(text)).toBe(want);
	});
});

describe("claimedSections", () => {
	test("a section runs to the next heading of the same or a higher level, subsections included", () => {
		const report = [
			"# Review",
			"## DEFECT: one",
			"body one",
			"### Trigger",
			"t1",
			"## DEFECT: two",
			"body two",
			"## NOT A DEFECT",
			"cleared",
			"# Verdict",
		].join("\n");
		const s = claimedSections(report);
		expect(s).toHaveLength(2);
		expect(s[0]).toContain("### Trigger");
		expect(s[0]).not.toContain("body two");
		expect(s[1]).not.toContain("cleared");
	});

	test("a heading inside a fenced block is output, not structure", () => {
		const report = ["## DEFECT: one", "```", "## NOT A DEFECT", "still output", "```", "tail of one"].join("\n");
		const s = claimedSections(report);
		expect(s).toHaveLength(1);
		expect(s[0]).toContain("tail of one");
	});

	test("a cleared suspicion under NOT A DEFECT is not a claim", () => {
		expect(claimedSections("## NOT A DEFECT\nthe autocomplete disposer after the session").length).toBe(0);
	});
});

describe("isFormatted", () => {
	test("a report with no claim and no NO DEFECTS line is unformatted", () => {
		expect(isFormatted("Everything looks fine.")).toBe(false);
		expect(isFormatted("Everything looks fine.\n\nNO DEFECTS\n")).toBe(true);
		expect(isFormatted("## DEFECT: x\ny")).toBe(true);
	});
});

describe("scoreRun", () => {
	test("a decoy cleared under NOT A DEFECT is mentioned but not asserted", () => {
		const s = scoreRun(
			cases,
			run(
				[
					"## DEFECT: restore record follows a symlink",
					"The .restoring restore record is written through a symlink and the target is overwritten.",
					"## NOT A DEFECT",
					"My harness showed the addAutocompleteProvider disposer running after the session; it is declared void, so that was my harness.",
				].join("\n"),
			),
		);
		expect(s.found).toEqual(["D-1"]);
		expect(s.asserted).toEqual([]);
		expect(s.mentionedDecoys).toEqual(["F-1"]);
		expect(s.unmatchedClaims).toBe(0);
	});

	test("a decoy under a DEFECT heading is asserted, and an unknown claim is counted", () => {
		const s = scoreRun(
			cases,
			run(
				[
					"## DEFECT: autocomplete disposer outlives the session",
					"The addAutocompleteProvider disposer runs after the session is disposed.",
					"## DEFECT: something nobody recorded",
					"A claim matching no case.",
				].join("\n"),
			),
		);
		expect(s.asserted).toEqual(["F-1"]);
		expect(s.found).toEqual([]);
		expect(s.claims).toBe(2);
		expect(s.unmatchedClaims).toBe(1);
	});

	test("a real defect named only outside a claim is mentioned, not found", () => {
		const s = scoreRun(cases, run("NO DEFECTS\n\nI checked whether a FIFO at the name hangs inside the gc lock."));
		expect(s.found).toEqual([]);
		expect(s.mentionedFindings).toEqual(["D-2"]);
	});
});

describe("gradeClaims", () => {
	test("errored and unformatted runs are excluded from n and counted", () => {
		const runs = [
			run("## DEFECT: fifo\nA FIFO at the name hangs inside the gc lock.", { runId: "a", trial: 1 }),
			run("", { runId: "b", trial: 2, error: "spend cap reached" }),
			run("Looks fine to me.", { runId: "c", trial: 3 }),
		];
		const [r] = gradeClaims(cases, runs);
		expect(r?.runs).toBe(1);
		expect(r?.erroredRuns).toBe(1);
		expect(r?.unformattedRuns).toBe(1);
		expect(r?.findings.n).toBe(2);
		expect(r?.findings.hits).toBe(1);
		expect(r?.decoys.n).toBe(1);
		expect(r?.decoys.hits).toBe(0);
		// D-2 is the one the original Claude arm missed.
		expect(r?.findingsClaudeMissed).toMatchObject({ n: 1, hits: 1 });
		expect(r?.findingsAstraMissed).toMatchObject({ n: 1, hits: 0 });
		expect(r?.perCase["D-2"]).toEqual({ kind: "finding", n: 1, hits: 1, mentioned: 1 });
	});
});

describe("compareClaims", () => {
	test("pairs by head and trial; a decoy asserted by one arm only shows as a decoy delta", () => {
		const claim = "## DEFECT: fifo\nA FIFO at the name hangs inside the gc lock.";
		const decoy = "\n## DEFECT: disposer\nThe addAutocompleteProvider disposer runs after the session.";
		const runs = [
			run(claim, { runId: "a1", arm: "a", trial: 1 }),
			run(claim + decoy, { runId: "b1", arm: "b", trial: 1 }),
			run(claim, { runId: "a2", arm: "a", trial: 2 }),
			run(claim + decoy, { runId: "b2", arm: "b", trial: 2 }),
		];
		const p = compareClaims(cases, gradeClaims(cases, runs), "a", "b");
		expect(p.pairs).toBe(2);
		expect(p.findings.deltaPp).toBe(0);
		expect(p.decoys.deltaPp).toBe(-100);
	});
});

describe("promptSatisfies", () => {
	test("a prompt that states a case's mechanism and trigger satisfies it", () => {
		expect(promptSatisfies("Check whether a FIFO hangs inside the gc lock.", cases)).toEqual(["D-2"]);
		expect(promptSatisfies("Find defects.", cases)).toEqual([]);
	});
});

describe("run.ts", () => {
	test("the prose prompt is the earlier lanes' text and the claims prompt asks for DEFECT headings", () => {
		const prose = userPrompt(head, "/s", 20, false);
		expect(userPrompt(head, "/s", 20, false, "prose")).toBe(prose);
		expect(prose).toContain("one section per defect, worst first, each naming the");
		expect(prose).not.toContain("## DEFECT:");
		const claims = userPrompt(head, "/s", 20, false, "claims");
		expect(claims).toContain("`## DEFECT:`");
		expect(claims).toContain("`## NOT A DEFECT`");
		expect(claims).toContain("`NO DEFECTS`");
	});

	test("preflight names a missing snapshot, a dangling dependency link and a missing patch", () => {
		expect(preflight(head)).toEqual([
			"h1: snapshot /nonexistent/snapshot does not exist",
			"h1: patch /nonexistent/patch.diff does not exist",
		]);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-preflight-"));
		try {
			fs.mkdirSync(path.join(dir, "snap", "node_modules"), { recursive: true });
			fs.symlinkSync(path.join(dir, "gone"), path.join(dir, "snap", "node_modules", "dep"));
			fs.writeFileSync(path.join(dir, "p.diff"), "");
			const problems = preflight({ ...head, checkout: path.join(dir, "snap"), diff: path.join(dir, "p.diff") });
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("1 dangling links");
			fs.rmSync(path.join(dir, "snap", "node_modules", "dep"));
			expect(preflight({ ...head, checkout: path.join(dir, "snap"), diff: path.join(dir, "p.diff") })).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

const corpus = loadClaimsCorpus(path.join(import.meta.dir, "corpus", "claims"));
type Rec = CorpusDefect | CorpusDecoy;
const records: Rec[] = [...corpus.defects, ...corpus.decoys];
const texts = (r: Rec): string[] => (r.kind === "defect" ? r.finder_sections : r.claimed_by).map(s => s.text);
/** A record's patterns in the order the builder writes them to the case file. */
const patterns = (r: Rec): Finding => ({
	id: r.id,
	head: headId(r),
	severity: "",
	how_found_primary: "",
	title: "",
	...anchored(r, texts(r)),
});
/**
 * The one pair whose source texts nest: the Claude arm withdrew the autocomplete
 * disposer in the same paragraph that states its real `onTerminalInput` finding,
 * so the decoy's text is inside the defect's. The decoy's patterns require
 * `autocomplete`, which the defect's paragraph quotes.
 */
const NESTED: Record<string, string> = { "F-17402-r53-1": "D-17402-r53-6" };

describe("corpus/claims", () => {
	test("ids are unique and every label is from its enum", () => {
		const ids = records.map(r => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const d of corpus.defects) {
			expect(ARM_LABELS).toContain(d.found_by.astra);
			expect(ARM_LABELS).toContain(d.found_by.claude);
			expect(HOW_FOUND as readonly string[]).toContain(d.how_found_primary);
		}
		for (const d of corpus.decoys) expect(DECOY_CLASSES).toContain(d.decoy_class);
	});

	test("every record sits on a head the corpus has a round record for", () => {
		const heads = new Set(corpus.rounds.map(r => `${headId(r)}@${r.head_sha}`));
		for (const r of records) expect(heads.has(`${headId(r)}@${r.head_sha}`)).toBe(true);
	});

	test("every record's patterns fire on each of its own source texts", () => {
		const misses = records.flatMap(r =>
			texts(r)
				.filter(t => !detects(t, patterns(r), 1200))
				.map(() => r.id),
		);
		expect(misses).toEqual([]);
	});

	test("no record's patterns fire on another record's source text at the same head", () => {
		const collisions: string[] = [];
		for (const a of records)
			for (const b of records) {
				if (a === b || headId(a) !== headId(b) || NESTED[a.id] === b.id) continue;
				if (texts(b).some(t => detects(t, patterns(a), 1200))) collisions.push(`${a.id} fires on ${b.id}`);
			}
		expect(collisions).toEqual([]);
	});
});

const casesPath = path.join(import.meta.dir, "cases-c.json");
describe.if(fs.existsSync(casesPath))("cases-c.json", () => {
	const cases = (fs.existsSync(casesPath) ? JSON.parse(fs.readFileSync(casesPath, "utf8")) : {}) as BuiltCases;

	test("every case's patterns, as frozen, fire on each source text of its corpus record", () => {
		const byId = new Map(records.map(r => [r.id, r]));
		const misses = [...cases.findings, ...cases.decoys.map(asPatterns)].filter(c => {
			const r = byId.get(c.id);
			return r === undefined || !texts(r).every(t => detects(t, c, cases.window_chars));
		});
		expect(misses.map(m => m.id)).toEqual([]);
	});

	test("is the corpus at the selected heads, record for record", () => {
		const ids = new Set(cases.heads.map(h => h.id));
		const want = [
			...corpus.defects.filter(d => ids.has(headId(d))).map(d => d.id),
			...corpus.decoys.filter(d => ids.has(headId(d)) && decoyEligible(d)).map(d => d.id),
		].sort();
		expect([...cases.findings.map(f => f.id), ...cases.decoys.map(d => d.id)].sort()).toEqual(want);
		for (const f of cases.findings) expect(ids.has(f.head)).toBe(true);
		for (const d of cases.decoys) expect(ids.has(d.head)).toBe(true);
	});

	test("no arm prompt satisfies a case by its own text", () => {
		for (const file of fs.readdirSync(path.join(import.meta.dir, "prompts"))) {
			const text = fs.readFileSync(path.join(import.meta.dir, "prompts", file), "utf8");
			expect({ file, ids: promptSatisfies(text, cases) }).toEqual({ file, ids: [] });
		}
	});

	test("the claims instructions in the run prompt satisfy no case either", () => {
		const h = cases.heads[0] as HeadCase;
		expect(promptSatisfies(userPrompt(h, "/scratch", 20, false, "claims"), cases)).toEqual([]);
	});
});
