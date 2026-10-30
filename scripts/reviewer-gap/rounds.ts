#!/usr/bin/env bun
/**
 * Sequence-level scoring for the reviewer-rounds eval.
 *
 * Detection is `detects` from `grade.ts`, unchanged, against the same frozen
 * `cases.json`. This file only composes per-round detections into sequences:
 *
 *   union        - a finding counts for a sequence when the frozen rule fires on
 *                  at least one of that sequence's rounds. This is the primary
 *                  score, because the corpus it is graded against was itself
 *                  harvested across all rounds of each night-time review.
 *   final-round  - the frozen rule on the last round alone.
 *   first-round  - the frozen rule on round 1 alone; for a multi-round arm this
 *                  is a fresh replication of the one-round arm.
 *
 * A one-round arm from the first eval's run directory is loaded as a sequence of
 * one round, so the old and new arms are scored by exactly the same code.
 *
 * Usage:
 *   bun scripts/reviewer-gap/rounds.ts --runs <dir>[,<dir>...] [--cases cases.json]
 *                                      [--freeze rounds-freeze.json] [--json out.json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type CaseFile,
	type Finding,
	type Interval,
	type RunRecord,
	clusterBootstrap,
	detects,
	wilson,
} from "./grade.ts";

export interface RoundRun extends RunRecord {
	sequence?: string;
	round?: number;
	rounds?: number;
}

export interface Sequence {
	id: string;
	arm: string;
	head: string;
	trial: number;
	model: string;
	/** Usable rounds, ordered; a round recorded with an error is dropped. */
	rounds: RoundRun[];
	failedRounds: number;
	costUsd: number;
	elapsedMs: number;
}

/** Group run records into sequences. A run with no `sequence` is its own. */
export function toSequences(runs: RoundRun[]): Sequence[] {
	const byId = new Map<string, Sequence>();
	for (const run of runs) {
		const id = run.sequence ?? run.runId;
		const seq = byId.get(id) ?? {
			id,
			arm: run.arm,
			head: run.head,
			trial: run.trial,
			model: run.model,
			rounds: [],
			failedRounds: 0,
			costUsd: 0,
			elapsedMs: 0,
		};
		seq.costUsd += run.costUsd;
		seq.elapsedMs += run.elapsedMs;
		if (run.error === undefined && run.report.trim().length > 0) seq.rounds.push(run);
		else seq.failedRounds++;
		byId.set(id, seq);
	}
	const out = [...byId.values()];
	for (const seq of out) seq.rounds.sort((a, b) => (a.round ?? 1) - (b.round ?? 1));
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type Scope = "union" | "final" | "first";

/** Which rounds of a sequence a score looks at. */
export function roundsInScope(seq: Sequence, scope: Scope): RoundRun[] {
	if (seq.rounds.length === 0) return [];
	if (scope === "union") return seq.rounds;
	if (scope === "first") return [seq.rounds[0] as RoundRun];
	return [seq.rounds[seq.rounds.length - 1] as RoundRun];
}

export function detectedBySequence(seq: Sequence, finding: Finding, windowChars: number, scope: Scope): boolean {
	return roundsInScope(seq, scope).some(r => detects(r.report, finding, windowChars));
}

/** The round number at which a finding first appears, or 0 if never. */
export function firstRoundDetected(seq: Sequence, finding: Finding, windowChars: number): number {
	for (const r of seq.rounds) if (detects(r.report, finding, windowChars)) return r.round ?? 1;
	return 0;
}

export interface ArmScore {
	arm: string;
	model: string;
	scope: Scope;
	sequences: number;
	roundsPerSequence: number;
	n: number;
	detected: number;
	rate: number;
	wilson: Interval;
	bootstrap: Interval;
	costUsd: number;
	failedRounds: number;
	/** union scope only: how many (finding, sequence) pairs first appeared at round k. */
	firstSeenAtRound: Record<number, number>;
}

function findingsByHead(cases: CaseFile): Map<string, Finding[]> {
	const m = new Map<string, Finding[]>();
	for (const f of cases.findings) m.set(f.head, [...(m.get(f.head) ?? []), f]);
	return m;
}

export function scoreArms(cases: CaseFile, sequences: Sequence[], scope: Scope): ArmScore[] {
	const byHead = findingsByHead(cases);
	const arms = new Map<string, Sequence[]>();
	for (const s of sequences) arms.set(s.arm, [...(arms.get(s.arm) ?? []), s]);
	const out: ArmScore[] = [];
	for (const [arm, armSeqs] of arms) {
		// A sequence with no usable round is not a score.
		const usable = armSeqs.filter(s => s.rounds.length > 0);
		const clusters: { successes: number; n: number }[] = [];
		const firstSeenAtRound: Record<number, number> = {};
		let detected = 0;
		let n = 0;
		for (const seq of usable) {
			const findings = byHead.get(seq.head) ?? [];
			let hits = 0;
			for (const f of findings) {
				if (detectedBySequence(seq, f, cases.window_chars, scope)) {
					hits++;
					if (scope === "union") {
						const k = firstRoundDetected(seq, f, cases.window_chars);
						firstSeenAtRound[k] = (firstSeenAtRound[k] ?? 0) + 1;
					}
				}
			}
			clusters.push({ successes: hits, n: findings.length });
			detected += hits;
			n += findings.length;
		}
		out.push({
			arm,
			model: usable[0]?.model ?? armSeqs[0]?.model ?? "",
			scope,
			sequences: usable.length,
			roundsPerSequence: usable.length === 0 ? 0 : usable.reduce((a, s) => a + s.rounds.length, 0) / usable.length,
			n,
			detected,
			rate: n === 0 ? 0 : detected / n,
			wilson: wilson(detected, n),
			bootstrap: clusterBootstrap(clusters),
			costUsd: armSeqs.reduce((a, s) => a + s.costUsd, 0),
			failedRounds: armSeqs.reduce((a, s) => a + s.failedRounds, 0),
			firstSeenAtRound,
		});
	}
	return out.sort((a, b) => b.rate - a.rate);
}

/**
 * The same PRNG `grade.ts` uses, copied rather than imported: `grade.ts` is a
 * frozen artefact whose sha256 the design freeze records, so it is not edited
 * to export a helper. `rounds.test.ts` asserts the two agree.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface PairedResult {
	a: string;
	b: string;
	pairs: number;
	deltaPp: number;
	lo: number;
	hi: number;
	aWins: number;
	bWins: number;
	ties: number;
}

/**
 * Paired cluster bootstrap over (head, trial) pairs. Both arms saw the same
 * head and the same trial index, so the pair is the resampling unit; resampling
 * findings would ignore that findings inside one run are not independent.
 */
export function pairedCompare(
	cases: CaseFile,
	sequences: Sequence[],
	armA: string,
	armB: string,
	scope: Scope,
	iterations = 10000,
	seed = 20261030,
): PairedResult {
	const byHead = findingsByHead(cases);
	const key = (s: Sequence): string => `${s.head}__t${s.trial}`;
	const a = new Map<string, Sequence>();
	const b = new Map<string, Sequence>();
	for (const s of sequences) {
		if (s.rounds.length === 0) continue;
		if (s.arm === armA) a.set(key(s), s);
		if (s.arm === armB) b.set(key(s), s);
	}
	const pairs: { da: number; db: number; n: number }[] = [];
	let aWins = 0;
	let bWins = 0;
	let ties = 0;
	for (const [k, sa] of [...a].sort()) {
		const sb = b.get(k);
		if (sb === undefined) continue;
		const findings = byHead.get(sa.head) ?? [];
		let da = 0;
		let db = 0;
		for (const f of findings) {
			if (detectedBySequence(sa, f, cases.window_chars, scope)) da++;
			if (detectedBySequence(sb, f, cases.window_chars, scope)) db++;
		}
		pairs.push({ da, db, n: findings.length });
		if (da > db) aWins++;
		else if (db > da) bWins++;
		else ties++;
	}
	const rate = (sel: { da: number; db: number; n: number }[]): number => {
		const n = sel.reduce((x, p) => x + p.n, 0);
		if (n === 0) return 0;
		return (sel.reduce((x, p) => x + p.da, 0) - sel.reduce((x, p) => x + p.db, 0)) / n;
	};
	const point = rate(pairs);
	const rnd = mulberry32(seed);
	const draws: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const sel = Array.from(
			{ length: pairs.length },
			() => pairs[Math.floor(rnd() * pairs.length)] as (typeof pairs)[0],
		);
		draws.push(rate(sel));
	}
	draws.sort((x, y) => x - y);
	const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))] ?? 0;
	return {
		a: armA,
		b: armB,
		pairs: pairs.length,
		deltaPp: 100 * point,
		lo: 100 * at(0.025),
		hi: 100 * at(0.975),
		aWins,
		bWins,
		ties,
	};
}

/** log of n! by lgamma, for the hypergeometric terms of Fisher's exact test. */
function lnFactorial(n: number): number {
	let s = 0;
	for (let i = 2; i <= n; i++) s += Math.log(i);
	return s;
}

function hypergeomP(a: number, b: number, c: number, d: number): number {
	const n = a + b + c + d;
	return Math.exp(
		lnFactorial(a + b) +
			lnFactorial(c + d) +
			lnFactorial(a + c) +
			lnFactorial(b + d) -
			lnFactorial(n) -
			lnFactorial(a) -
			lnFactorial(b) -
			lnFactorial(c) -
			lnFactorial(d),
	);
}

/** Two-sided Fisher exact test on a 2x2 table, by summing tables no more likely. */
export function fisherExact(a: number, b: number, c: number, d: number): number {
	const observed = hypergeomP(a, b, c, d);
	const row1 = a + b;
	const col1 = a + c;
	const n = a + b + c + d;
	let p = 0;
	for (let x = Math.max(0, col1 - (n - row1)); x <= Math.min(row1, col1); x++) {
		const q = hypergeomP(x, row1 - x, col1 - x, n - row1 - col1 + x);
		if (q <= observed * (1 + 1e-9)) p += q;
	}
	return Math.min(1, p);
}

export interface ClassResult {
	arm: string;
	sequences: number;
	pairs: number;
	hits: number;
	firstSeenAtRound: Record<number, number>;
}

export function scoreClass(cases: CaseFile, sequences: Sequence[], findingIds: string[], scope: Scope): ClassResult[] {
	const wanted = new Set(findingIds);
	const byHead = findingsByHead(cases);
	const arms = new Map<string, Sequence[]>();
	for (const s of sequences) if (s.rounds.length > 0) arms.set(s.arm, [...(arms.get(s.arm) ?? []), s]);
	const out: ClassResult[] = [];
	for (const [arm, armSeqs] of arms) {
		let pairs = 0;
		let hits = 0;
		let seqs = 0;
		const firstSeenAtRound: Record<number, number> = {};
		for (const seq of armSeqs) {
			const findings = (byHead.get(seq.head) ?? []).filter(f => wanted.has(f.id));
			if (findings.length === 0) continue;
			seqs++;
			for (const f of findings) {
				pairs++;
				if (detectedBySequence(seq, f, cases.window_chars, scope)) {
					hits++;
					const k = firstRoundDetected(seq, f, cases.window_chars);
					firstSeenAtRound[k] = (firstSeenAtRound[k] ?? 0) + 1;
				}
			}
		}
		out.push({ arm, sequences: seqs, pairs, hits, firstSeenAtRound });
	}
	return out.sort((a, b) => a.arm.localeCompare(b.arm));
}

export function loadRoundRuns(dirs: string[]): RoundRun[] {
	const out: RoundRun[] = [];
	for (const dir of dirs) {
		for (const entry of fs.readdirSync(dir)) {
			if (!entry.endsWith(".json")) continue;
			if (entry === "results.json" || entry === "plan.json" || entry === "rounds-results.json") continue;
			out.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as RoundRun);
		}
	}
	return out;
}

function pct(x: number): string {
	return `${(100 * x).toFixed(1)}%`;
}

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runsArg = get("--runs");
	if (runsArg === undefined) {
		console.error("usage: rounds.ts --runs <dir>[,<dir>...] [--cases ...] [--freeze ...] [--json out.json]");
		process.exit(2);
	}
	const cases = JSON.parse(
		fs.readFileSync(get("--cases") ?? path.join(import.meta.dir, "cases.json"), "utf8"),
	) as CaseFile;
	const freeze = JSON.parse(
		fs.readFileSync(get("--freeze") ?? path.join(import.meta.dir, "rounds-freeze.json"), "utf8"),
	) as {
		frozen_at: string;
		symlink_class: { finding_ids: string[] };
		comparisons: { name: string; test: string }[];
	};
	// The reused one-round arms keep their first-eval names; rename them to the
	// frozen arm names so one table carries both evals.
	const rename: Record<string, string> = { candidate: "single", crossfamily: "crossfamily-single" };
	const runs = loadRoundRuns(runsArg.split(",")).map(r => ({ ...r, arm: rename[r.arm] ?? r.arm }));
	const keep = new Set(["single", "crossfamily-single", "retry-blind", "rounds-carry"]);
	const sequences = toSequences(runs.filter(r => keep.has(r.arm)));

	console.log(
		`cases frozen ${cases.frozen_at}; design frozen ${freeze.frozen_at}; ${cases.findings.length} findings\n`,
	);
	const scopes: Scope[] = ["union", "final", "first"];
	const all: Record<string, ArmScore[]> = {};
	for (const scope of scopes) {
		const scores = scoreArms(cases, sequences, scope);
		all[scope] = scores;
		console.log(`### scope: ${scope}\n`);
		console.log(
			"| arm | model | sequences | rounds/seq | n | detected | rate | 95% Wilson | 95% cluster bootstrap | cost USD | failed rounds |",
		);
		console.log("|---|---|---:|---:|---:|---:|---:|---|---|---:|---:|");
		for (const s of scores) {
			console.log(
				`| ${s.arm} | ${s.model} | ${s.sequences} | ${s.roundsPerSequence.toFixed(1)} | ${s.n} | ${s.detected} | ${pct(s.rate)} | ${pct(s.wilson.lo)}–${pct(s.wilson.hi)} | ${pct(s.bootstrap.lo)}–${pct(s.bootstrap.hi)} | ${s.costUsd.toFixed(2)} | ${s.failedRounds} |`,
			);
		}
		console.log("");
	}

	console.log("### first round at which a union hit appeared\n");
	console.log("| arm | round 1 | round 2 | round 3 |");
	console.log("|---|---:|---:|---:|");
	for (const s of all.union ?? []) {
		const f = s.firstSeenAtRound;
		console.log(`| ${s.arm} | ${f[1] ?? 0} | ${f[2] ?? 0} | ${f[3] ?? 0} |`);
	}

	console.log("\n### paired comparisons, union scope, cluster bootstrap over (head, trial) pairs\n");
	console.log("| comparison | pairs | delta pp | 95% interval | A wins | B wins | ties |");
	console.log("|---|---:|---:|---|---:|---:|---:|");
	const paired: PairedResult[] = [];
	for (const cmp of freeze.comparisons) {
		const m = /^(\S+)\s*-\s*(\S+)$/.exec(cmp.test);
		if (m === null) continue;
		const [, armA, armB] = m as unknown as [string, string, string];
		const r = pairedCompare(cases, sequences, armA, armB, "union");
		if (r.pairs === 0) continue;
		paired.push(r);
		console.log(
			`| ${cmp.name}: ${armA} − ${armB} | ${r.pairs} | ${r.deltaPp >= 0 ? "+" : ""}${r.deltaPp.toFixed(1)} | [${r.lo.toFixed(1)}, ${r.hi.toFixed(1)}] | ${r.aWins} | ${r.bWins} | ${r.ties} |`,
		);
	}

	console.log("\n### symlink / alias class\n");
	const cls = scoreClass(cases, sequences, freeze.symlink_class.finding_ids, "union");
	console.log("| arm | sequences with a class finding | pairs | hits | first seen r1 | r2 | r3 |");
	console.log("|---|---:|---:|---:|---:|---:|---:|");
	for (const c of cls) {
		console.log(
			`| ${c.arm} | ${c.sequences} | ${c.pairs} | ${c.hits} | ${c.firstSeenAtRound[1] ?? 0} | ${c.firstSeenAtRound[2] ?? 0} | ${c.firstSeenAtRound[3] ?? 0} |`,
		);
	}
	const fisher: { a: string; b: string; p: number }[] = [];
	const find = (arm: string): ClassResult | undefined => cls.find(c => c.arm === arm);
	for (const [x, y] of [
		["crossfamily-single", "rounds-carry"],
		["crossfamily-single", "single"],
		["rounds-carry", "single"],
		["rounds-carry", "retry-blind"],
	] as [string, string][]) {
		const cx = find(x);
		const cy = find(y);
		if (cx === undefined || cy === undefined) continue;
		const p = fisherExact(cx.hits, cx.pairs - cx.hits, cy.hits, cy.pairs - cy.hits);
		fisher.push({ a: x, b: y, p });
		console.log(
			`\nFisher two-sided, ${x} ${cx.hits}/${cx.pairs} vs ${y} ${cy.hits}/${cy.pairs}: p = ${p.toFixed(4)}`,
		);
	}

	const totalCost = sequences.reduce((a, s) => a + s.costUsd, 0);
	console.log(`\ntotal recorded spend over all arms shown: $${totalCost.toFixed(2)}`);

	const jsonOut = get("--json");
	if (jsonOut !== undefined)
		fs.writeFileSync(
			jsonOut,
			`${JSON.stringify(
				{
					cases_frozen_at: cases.frozen_at,
					design_frozen_at: freeze.frozen_at,
					scores: all,
					paired,
					symlinkClass: cls,
					symlinkFisher: fisher,
					totalCost,
				},
				null,
				2,
			)}\n`,
		);
}

if (import.meta.main) main();
