#!/usr/bin/env bun
/**
 * Scoring for the re-derivation lane (`rederive-freeze.json`).
 *
 * Nothing here redefines detection. Per-arm rates are `gradeRuns` from
 * `grade.ts`, paired deltas are `pairedCompare` from `rounds.ts`, both as the
 * first two lanes used them. This file only selects strata, arms and finding
 * subsets, and adds the corpus classification: the two labellers' agreement
 * and the share of the class, from `corpus/rederive-labels/`.
 *
 * Usage:
 *   bun scripts/reviewer-gap/rederive.ts [--a <dir>[,<dir>...]] [--b <dir>[,<dir>...]]
 *        [--stored <first-eval run dir>] [--json <out.json>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadFindings } from "./corpus.ts";
import {
	type ArmResult,
	type CaseFile,
	type Interval,
	type RunRecord,
	detects,
	gradeRuns,
	loadRuns,
	wilson,
} from "./grade.ts";
import { type PairedResult, pairedCompare, toSequences } from "./rounds.ts";

export const LABELS = ["instance", "adjacent", "not"] as const;
export type Label = (typeof LABELS)[number];

export interface LabelRecord {
	id: string;
	label: Label;
	shape: string | null;
	t1: string | null;
	t2: string | null;
	window: string | null;
	reason: string;
}

export interface FinalLabel extends LabelRecord {
	stratum: "A" | "B";
	/** Each labeller's label, by labeller name. */
	labellers: Record<string, Label>;
	/** Present when the labellers disagreed: why the final label was chosen. */
	adjudication?: string;
}

export const LABELLERS = ["claude", "astra"] as const;

interface Adjudication {
	decisions: Record<string, { from: (typeof LABELLERS)[number]; label: Label; why: string }>;
}

/**
 * One label per record of both strata. Where the two labellers agree the first
 * labeller's record is kept; where they disagree the adjudication names whose
 * record is kept and why. A disagreement without a decision, or a decision
 * whose label is not that labeller's, is an error.
 */
export function finalLabels(labelDir: string): FinalLabel[] {
	const adj = JSON.parse(fs.readFileSync(path.join(labelDir, "adjudication.json"), "utf8")) as Adjudication;
	const out: FinalLabel[] = [];
	const used = new Set<string>();
	for (const stratum of ["A", "B"] as const) {
		const [first, second] = LABELLERS.map(
			who =>
				new Map(
					readJsonl<LabelRecord>(path.join(labelDir, `${who}-${stratum.toLowerCase()}.jsonl`)).map(r => [r.id, r]),
				),
		) as [Map<string, LabelRecord>, Map<string, LabelRecord>];
		if (first.size !== second.size) throw new Error(`stratum ${stratum}: the labellers cover different records`);
		for (const [id, a] of first) {
			const b = second.get(id);
			if (b === undefined) throw new Error(`${id} has no second label`);
			const labellers = { [LABELLERS[0]]: a.label, [LABELLERS[1]]: b.label };
			if (a.label === b.label) {
				out.push({ ...a, stratum, labellers });
				continue;
			}
			const d = adj.decisions[id];
			if (d === undefined) throw new Error(`${id}: labellers disagree and no adjudication decides it`);
			const kept = d.from === LABELLERS[0] ? a : b;
			if (kept.label !== d.label)
				throw new Error(`${id}: adjudication keeps ${d.from}, whose label is ${kept.label}`);
			used.add(id);
			out.push({ ...kept, stratum, labellers, adjudication: d.why });
		}
	}
	const stale = Object.keys(adj.decisions).filter(id => !used.has(id));
	if (stale.length > 0) throw new Error(`adjudications for records the labellers agree on: ${stale.join(", ")}`);
	return out.sort((x, y) => x.id.localeCompare(y.id));
}

export function readJsonl<T>(file: string): T[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as T);
}

/** Run records of several directories, in run-id order so a bootstrap is reproducible. */
export function loadRunDirs(dirs: string[]): RunRecord[] {
	return dirs.flatMap(d => loadRuns(d)).sort((a, b) => a.runId.localeCompare(b.runId));
}

/** The same cases with only the findings `keep` accepts. Heads and detection are untouched. */
export function subsetCases(cases: CaseFile, keep: (id: string) => boolean): CaseFile {
	return { ...cases, findings: cases.findings.filter(f => keep(f.id)) };
}

/**
 * A and B as one case file, for the pooled comparison only. Head ids do not
 * collide, and both strata use the same window.
 */
export function poolCases(a: CaseFile, b: CaseFile): CaseFile {
	if (a.window_chars !== b.window_chars) throw new Error("strata use different windows; refusing to pool");
	const heads = new Set(a.heads.map(h => h.id));
	for (const h of b.heads) if (heads.has(h.id)) throw new Error(`head ${h.id} is in both strata`);
	return {
		frozen_at: `${a.frozen_at} + ${b.frozen_at}`,
		window_chars: a.window_chars,
		heads: [...a.heads, ...b.heads],
		findings: [...a.findings, ...b.findings],
	};
}

export function compare(cases: CaseFile, runs: RunRecord[], armA: string, armB: string): PairedResult {
	return pairedCompare(cases, toSequences(runs), armA, armB, "union");
}

/** The prompts of the arms this lane runs; the control appends nothing. */
export const ARM_PROMPTS = ["candidate.md", "rederive.md"];

/**
 * Per arm prompt, the findings whose spec the prompt's own text satisfies. An
 * arm can score those by echoing its prompt, so the guard comparison drops them.
 */
export function promptSatisfiable(dir: string, caseFiles: CaseFile[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const file of ARM_PROMPTS) {
		const text = fs.readFileSync(path.join(dir, "prompts", file), "utf8");
		out[file] = caseFiles
			.flatMap(c => c.findings.filter(f => detects(text, f, c.window_chars)))
			.map(f => f.id)
			.sort();
	}
	return out;
}

export interface Agreement {
	n: number;
	agree: number;
	kappa: number;
	binaryAgree: number;
	binaryKappa: number;
	confusion: Record<string, number>;
}

/** Cohen's kappa for two raters over the same items. */
export function cohenKappa(a: string[], b: string[]): number {
	if (a.length !== b.length || a.length === 0) throw new Error("kappa needs two equal, non-empty label lists");
	const n = a.length;
	const cats = [...new Set([...a, ...b])];
	let po = 0;
	for (let i = 0; i < n; i++) if (a[i] === b[i]) po++;
	po /= n;
	let pe = 0;
	for (const c of cats) pe += (a.filter(x => x === c).length / n) * (b.filter(x => x === c).length / n);
	return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export function agreement(x: LabelRecord[], y: LabelRecord[]): Agreement {
	const byId = new Map(y.map(r => [r.id, r]));
	const a: string[] = [];
	const b: string[] = [];
	const confusion: Record<string, number> = {};
	for (const r of x) {
		const o = byId.get(r.id);
		if (o === undefined) throw new Error(`${r.id} has no second label`);
		a.push(r.label);
		b.push(o.label);
		const k = `${r.label}/${o.label}`;
		confusion[k] = (confusion[k] ?? 0) + 1;
	}
	if (byId.size !== x.length) throw new Error("the two label files cover different ids");
	const bin = (l: string[]): string[] => l.map(v => (v === "instance" ? "instance" : "rest"));
	return {
		n: a.length,
		agree: a.filter((v, i) => v === b[i]).length,
		kappa: cohenKappa(a, b),
		binaryAgree: bin(a).filter((v, i) => v === bin(b)[i]).length,
		binaryKappa: cohenKappa(bin(a), bin(b)),
		confusion,
	};
}

export interface Share {
	scope: string;
	n: number;
	counts: Record<Label, number>;
	instance: { share: number; wilson: Interval };
	instanceOrAdjacent: { share: number; wilson: Interval };
}

export function share(scope: string, labels: Label[]): Share {
	const counts = { instance: 0, adjacent: 0, not: 0 } as Record<Label, number>;
	for (const l of labels) counts[l]++;
	const n = labels.length;
	const wide = counts.instance + counts.adjacent;
	return {
		scope,
		n,
		counts,
		instance: { share: n === 0 ? 0 : counts.instance / n, wilson: wilson(counts.instance, n) },
		instanceOrAdjacent: { share: n === 0 ? 0 : wide / n, wilson: wilson(wide, n) },
	};
}

const ARMS = ["rederive", "control", "candidate"];
const PAIRS: [string, string, string][] = [
	["primary", "rederive", "control"],
	["attribution", "rederive", "candidate"],
	["probe-prompt replication", "candidate", "control"],
];

function pct(x: number): string {
	return `${(100 * x).toFixed(1)}%`;
}

function signed(x: number): string {
	return `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
}

function armTable(title: string, results: ArmResult[]): void {
	console.log(`### ${title}\n`);
	console.log("| arm | runs | n | detected | rate | 95% Wilson | 95% cluster bootstrap | errored runs |");
	console.log("|---|---:|---:|---:|---:|---|---|---:|");
	for (const r of results)
		console.log(
			`| ${r.arm} | ${r.runs} | ${r.n} | ${r.detected} | ${pct(r.rate)} | ${pct(r.wilson.lo)}–${pct(r.wilson.hi)} | ${pct(r.bootstrap.lo)}–${pct(r.bootstrap.hi)} | ${r.failedRuns} |`,
		);
	console.log("");
}

function pairedRow(name: string, r: PairedResult): string {
	const verdict = r.lo <= 0 && r.hi >= 0 ? "null" : r.lo > 0 ? "A better" : "B better";
	return `| ${name}: ${r.a} − ${r.b} | ${r.pairs} | ${signed(r.deltaPp)} | [${signed(r.lo)}, ${signed(r.hi)}] | ${r.aWins} | ${r.bWins} | ${r.ties} | ${verdict} |`;
}

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const dir = import.meta.dir;
	const casesA = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8")) as CaseFile;
	const casesB = JSON.parse(fs.readFileSync(path.join(dir, "cases-b.json"), "utf8")) as CaseFile;
	const split = (v: string | undefined): string[] => (v === undefined ? [] : v.split(",").filter(s => s.length > 0));
	const runsA = loadRunDirs(split(get("--a"))).filter(r => ARMS.includes(r.arm));
	const runsB = loadRunDirs(split(get("--b"))).filter(r => ARMS.includes(r.arm));
	const out: Record<string, unknown> = { casesA: casesA.frozen_at, casesB: casesB.frozen_at };

	const labelDir = path.join(dir, "corpus", "rederive-labels");
	const labels = finalLabels(labelDir);
	const labelOf = new Map(labels.map(l => [l.id, l.label]));
	out.labels = labels;

	console.log("### labeller agreement (before adjudication)\n");
	const agreements: Record<string, Agreement> = {};
	for (const stratum of ["a", "b"]) {
		const [x, y] = LABELLERS.map(who => readJsonl<LabelRecord>(path.join(labelDir, `${who}-${stratum}.jsonl`))) as [
			LabelRecord[],
			LabelRecord[],
		];
		const ag = agreement(x, y);
		agreements[stratum.toUpperCase()] = ag;
		console.log(
			`stratum ${stratum.toUpperCase()}: n = ${ag.n}; three labels ${ag.agree} agree (${pct(ag.agree / ag.n)}), kappa ${ag.kappa.toFixed(2)}; instance against the rest ${ag.binaryAgree} agree (${pct(ag.binaryAgree / ag.n)}), kappa ${ag.binaryKappa.toFixed(2)}`,
		);
	}
	out.agreement = agreements;
	console.log("");

	const corpusIds = new Set(loadFindings().map(f => f.id));
	const caseIds = new Set(casesA.findings.map(f => f.id));
	const bIds = new Set(casesB.findings.map(f => f.id));
	const pick = (ids: Set<string>): Label[] => labels.filter(l => ids.has(l.id)).map(l => l.label);
	const shares = [
		share("corpus (197 findings)", pick(corpusIds)),
		share("stratum A cases (30 findings)", pick(caseIds)),
		share("stratum B (batch extension)", pick(bIds)),
	];
	out.shares = shares;
	console.log("### share of the class (adjudicated)\n");
	console.log(
		"| scope | n | instance | adjacent | not | instance share (95% Wilson) | instance or adjacent (95% Wilson) |",
	);
	console.log("|---|---:|---:|---:|---:|---|---|");
	for (const s of shares)
		console.log(
			`| ${s.scope} | ${s.n} | ${s.counts.instance} | ${s.counts.adjacent} | ${s.counts.not} | ${pct(s.instance.share)} (${pct(s.instance.wilson.lo)}–${pct(s.instance.wilson.hi)}) | ${pct(s.instanceOrAdjacent.share)} (${pct(s.instanceOrAdjacent.wilson.lo)}–${pct(s.instanceOrAdjacent.wilson.hi)}) |`,
		);
	console.log("");
	const shapes: Record<string, number> = {};
	for (const l of labels)
		if (l.label === "instance") shapes[`${l.stratum}:${l.shape}`] = (shapes[`${l.stratum}:${l.shape}`] ?? 0) + 1;
	out.shapes = shapes;
	console.log(`instance shapes by stratum: ${JSON.stringify(shapes)}\n`);

	const strata: [string, CaseFile, RunRecord[]][] = [
		["A", casesA, runsA],
		["B", casesB, runsB],
	];
	const echo = promptSatisfiable(dir, [casesA, casesB]);
	const echoIds = new Set(Object.values(echo).flat());
	out.promptSatisfiable = echo;
	const paired: Record<string, (PairedResult & { name: string })[]> = {};
	for (const [name, cases, runs] of strata) {
		if (runs.length === 0) continue;
		const arms = gradeRuns(cases, runs);
		out[`arms${name}`] = arms;
		armTable(`stratum ${name}: per arm`, arms);
		const rows: (PairedResult & { name: string })[] = [];
		const emit = (label: string, sub: CaseFile, a: string, b: string): void => {
			const r = compare(sub, runs, a, b);
			if (r.pairs === 0 || sub.findings.length === 0) return;
			rows.push({ name: label, ...r });
			console.log(pairedRow(label, r));
		};
		console.log(`### stratum ${name}: paired over (head, trial), cluster bootstrap\n`);
		console.log("| comparison | pairs | delta pp | 95% interval | A wins | B wins | ties | reading |");
		console.log("|---|---:|---:|---|---:|---:|---:|---|");
		for (const [label, a, b] of PAIRS) emit(label, cases, a, b);
		const guarded = subsetCases(cases, id => !echoIds.has(id));
		if (guarded.findings.length < cases.findings.length)
			for (const [label, a, b] of PAIRS)
				emit(
					`guard, ${label}, without ${cases.findings.length - guarded.findings.length} prompt-satisfiable`,
					guarded,
					a,
					b,
				);
		if (labels.length > 0) {
			const inClass = subsetCases(cases, id => labelOf.get(id) === "instance");
			emit(`instance findings only (${inClass.findings.length})`, inClass, "rederive", "control");
			const rest = subsetCases(cases, id => labelOf.get(id) !== "instance");
			emit(`every other finding (${rest.findings.length})`, rest, "rederive", "control");
		}
		paired[name] = rows;
		console.log("");
	}

	if (runsA.length > 0 && runsB.length > 0) {
		const pooled = poolCases(casesA, casesB);
		const r = compare(pooled, [...runsA, ...runsB], "rederive", "control");
		paired.pooled = [{ name: "pooled", ...r }];
		console.log("### POOLED over A and B (stated as pooled; the strata are reported separately above)\n");
		console.log("| comparison | pairs | delta pp | 95% interval | A wins | B wins | ties | reading |");
		console.log("|---|---:|---:|---|---:|---:|---:|---|");
		console.log(pairedRow("pooled", r));
		console.log("");
	}
	out.paired = paired;

	const stored = get("--stored");
	if (stored !== undefined && runsA.length > 0) {
		const old = loadRuns(stored).filter(r => r.arm === "control" || r.arm === "candidate");
		const renamed = old.map(r => ({ ...r, arm: `${r.arm} (first eval)` }));
		const cont = gradeRuns(casesA, [...renamed, ...runsA]);
		out.continuity = cont;
		armTable("stratum A: this lane beside the first eval's stored runs (unpaired; different time window)", cont);
	}

	const jsonOut = get("--json");
	if (jsonOut !== undefined) fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`);
}

if (import.meta.main) main();
