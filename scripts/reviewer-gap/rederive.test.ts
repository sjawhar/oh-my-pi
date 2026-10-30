import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOW_FOUND, SEVERITIES, loadFindings } from "./corpus.ts";
import { type CaseFile, type RunRecord, detects } from "./grade.ts";
import {
	type LabelRecord,
	agreement,
	cohenKappa,
	compare,
	finalLabels,
	poolCases,
	promptSatisfiable,
	readJsonl,
	share,
	subsetCases,
} from "./rederive.ts";
import { pairedCompare, toSequences } from "./rounds.ts";

const dir = import.meta.dir;
const casesA = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8")) as CaseFile;
const casesB = JSON.parse(fs.readFileSync(path.join(dir, "cases-b.json"), "utf8")) as CaseFile;
const recordsB = loadFindings(path.join(dir, "corpus", "findings-b"));
const freeze = JSON.parse(fs.readFileSync(path.join(dir, "rederive-freeze.json"), "utf8")) as {
	strata: { B: { rounds: { pr: number; round: number; head_sha: string }[] } };
};

/** Records whose report section gives no source link; `files` stays empty rather than inferred. */
const NO_SOURCE_LINK: Record<string, true> = { "17398-R19-3": true, "17412-R6-3": true };

describe("stratum B corpus records", () => {
	test("every record carries the frozen schema", () => {
		expect(recordsB.length).toBeGreaterThan(0);
		expect(new Set(recordsB.map(f => f.id)).size).toBe(recordsB.length);
		for (const f of recordsB) {
			expect(HOW_FOUND).toContain(f.how_found_primary);
			expect(SEVERITIES).toContain(f.severity);
			expect(f.id.startsWith(`${f.pr}-R${f.round}-`)).toBe(true);
			expect(f.head_sha).toHaveLength(40);
			expect(f.title.length).toBeGreaterThan(0);
			expect(f.trigger.length).toBeGreaterThan(0);
			expect(f.measured.trim().length).toBeGreaterThan(0);
			expect(f.how_found_quote.length).toBeGreaterThan(10);
			expect(f.closed).toBe(false);
			expect(f.closed_at_sha).toBeNull();
			if (NO_SOURCE_LINK[f.id] !== true) expect(f.files.length).toBeGreaterThan(0);
			const strongest = f.how_found.reduce((a, b) => (HOW_FOUND.indexOf(b) > HOW_FOUND.indexOf(a) ? b : a));
			expect({ id: f.id, primary: f.how_found_primary }).toEqual({ id: f.id, primary: strongest });
		}
	});

	test("records come only from the rounds the freeze names, at their heads", () => {
		const rounds = new Map(freeze.strata.B.rounds.map(r => [`${r.pr}/${r.round}`, r.head_sha]));
		for (const f of recordsB) expect(rounds.get(`${f.pr}/${f.round}`)).toBe(f.head_sha);
	});

	test("no stratum B id collides with the original corpus", () => {
		const a = new Set(loadFindings().map(f => f.id));
		for (const f of recordsB) expect(a.has(f.id)).toBe(false);
	});
});

describe("corpus classification", () => {
	test("every record of both strata has exactly one final label, and every disagreement is adjudicated", () => {
		const labels = finalLabels(path.join(dir, "corpus", "rederive-labels"));
		const ids = [...loadFindings().map(f => f.id), ...recordsB.map(f => f.id)].sort();
		expect(labels.map(l => l.id)).toEqual(ids);
		for (const l of labels) {
			const votes = Object.values(l.labellers);
			expect(votes).toHaveLength(2);
			expect(l.adjudication !== undefined).toBe(votes[0] !== votes[1]);
			if (l.label === "not") expect([l.t1, l.t2, l.window, l.shape]).toEqual([null, null, null, null]);
			if (l.label === "instance") expect(l.shape).not.toBeNull();
		}
	});
});

describe("cases-b.json", () => {
	test("one case per stratum B record, on the head of its round", () => {
		expect(casesB.findings.map(f => f.id).sort()).toEqual(recordsB.map(f => f.id).sort());
		const heads = new Map(casesB.heads.map(h => [h.id, h]));
		const byId = new Map(recordsB.map(f => [f.id, f]));
		for (const c of casesB.findings) {
			const head = heads.get(c.head);
			const record = byId.get(c.id);
			expect(head).toBeDefined();
			expect(record).toBeDefined();
			expect(head?.head_sha).toBe(record?.head_sha);
			expect(c.title).toBe(record?.title as string);
		}
	});

	test("the detection rule is the first stratum's", () => {
		expect(casesB.window_chars).toBe(casesA.window_chars);
		const aHeads = new Set(casesA.heads.map(h => h.id));
		for (const h of casesB.heads) expect(aHeads.has(h.id)).toBe(false);
	});

	test("every pattern compiles and no group is empty", () => {
		for (const f of casesB.findings) {
			expect(f.mechanism.length + f.trigger.length).toBeGreaterThan(1);
			for (const group of [...f.mechanism, ...f.trigger]) {
				expect(group.length).toBeGreaterThan(0);
				for (const pattern of group) expect(() => new RegExp(pattern, "gi")).not.toThrow();
			}
		}
	});

	test("no spec fires on a sibling finding's title at the same head", () => {
		const filler = "\u0000".repeat(5000);
		for (const f of casesB.findings) {
			const distractors = casesB.findings
				.filter(o => o.head === f.head && o.id !== f.id)
				.map(o => o.title)
				.join(filler);
			expect({ id: f.id, fires: detects(distractors, f, casesB.window_chars) }).toEqual({ id: f.id, fires: false });
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
		for (const f of casesB.findings)
			expect({ id: f.id, fires: detects(prose, f, casesB.window_chars) }).toEqual({ id: f.id, fires: false });
	});

	test("the specs an arm's prompt satisfies by itself are the ones the freeze names", () => {
		// A spec the prompt's own wording fires is one an arm can score by echoing
		// its prompt. The freeze names them and the guard comparison drops them.
		const frozen = JSON.parse(fs.readFileSync(path.join(dir, "rederive-freeze.json"), "utf8")) as {
			comparisons: { prompt_satisfiable: Record<string, string[]> };
		};
		expect(promptSatisfiable(dir, [casesA, casesB])).toEqual(frozen.comparisons.prompt_satisfiable);
	});
});

function run(arm: string, head: string, trial: number, report: string): RunRecord {
	return {
		runId: `${arm}__${head}__t${trial}`,
		arm,
		head,
		trial,
		model: "m",
		report,
		costUsd: 0,
		elapsedMs: 0,
		exitCode: 0,
	};
}

const toy: CaseFile = {
	frozen_at: "t",
	window_chars: 1200,
	heads: [
		{ id: "h1", pr: 1, round: 1, head_sha: "a", base_sha: "b", checkout: "", diff: "", subject: "", packages: [] },
	],
	findings: [
		{ id: "F-1", head: "h1", severity: "P1", how_found_primary: "write-probe", title: "", mechanism: [["alpha"]], trigger: [["beta"]] },
		{ id: "F-2", head: "h1", severity: "P2", how_found_primary: "write-probe", title: "", mechanism: [["gamma"]], trigger: [["delta"]] },
	],
};

describe("composer", () => {
	const runs = [
		run("rederive", "h1", 1, "alpha beta gamma delta"),
		run("control", "h1", 1, "alpha beta"),
		run("rederive", "h1", 2, "gamma delta"),
		run("control", "h1", 2, "nothing"),
	];

	test("compare is pairedCompare on single-run sequences", () => {
		const r = compare(toy, runs, "rederive", "control");
		const direct = pairedCompare(toy, toSequences(runs), "rederive", "control", "union");
		expect(r).toEqual(direct);
		expect(r.pairs).toBe(2);
		expect(r.deltaPp).toBeCloseTo(50, 5);
	});

	test("a subset keeps heads and detection and drops only findings", () => {
		const sub = subsetCases(toy, id => id === "F-1");
		expect(sub.heads).toEqual(toy.heads);
		expect(sub.findings.map(f => f.id)).toEqual(["F-1"]);
		expect(compare(sub, runs, "rederive", "control").deltaPp).toBeCloseTo(0, 5);
	});

	test("pooling refuses colliding heads and different windows", () => {
		expect(() => poolCases(toy, toy)).toThrow();
		expect(() => poolCases(toy, { ...toy, heads: [], findings: [], window_chars: 600 })).toThrow();
		expect(poolCases(casesA, casesB).findings.length).toBe(casesA.findings.length + casesB.findings.length);
	});

	test("kappa is 1 for identical raters and 0 for chance agreement", () => {
		expect(cohenKappa(["a", "b", "a"], ["a", "b", "a"])).toBe(1);
		expect(cohenKappa(["a", "a", "b", "b"], ["a", "b", "a", "b"])).toBeCloseTo(0, 10);
	});

	test("agreement refuses label files over different ids", () => {
		const l = (id: string, label: LabelRecord["label"]): LabelRecord => ({
			id,
			label,
			shape: null,
			t1: null,
			t2: null,
			window: null,
			reason: "",
		});
		expect(() => agreement([l("x", "not")], [l("y", "not")])).toThrow();
		// adjacent and not disagree on three labels and agree on instance-against-the-rest.
		const ag = agreement([l("x", "adjacent"), l("y", "instance")], [l("x", "not"), l("y", "instance")]);
		expect(ag.agree).toBe(1);
		expect(ag.binaryAgree).toBe(2);
		expect(ag.confusion).toEqual({ "adjacent/not": 1, "instance/instance": 1 });
	});

	test("share counts labels with Wilson intervals", () => {
		const s = share("s", ["instance", "adjacent", "not", "not"]);
		expect(s.counts).toEqual({ instance: 1, adjacent: 1, not: 2 });
		expect(s.instance.share).toBe(0.25);
		expect(s.instanceOrAdjacent.share).toBe(0.5);
	});

	test("readJsonl skips blank lines", () => {
		const f = path.join(process.env.TMPDIR ?? "/tmp", `rederive-${process.pid}.jsonl`);
		fs.writeFileSync(f, '{"a":1}\n\n{"a":2}\n');
		try {
			expect(readJsonl<{ a: number }>(f)).toEqual([{ a: 1 }, { a: 2 }]);
		} finally {
			fs.rmSync(f, { force: true });
		}
	});
});
