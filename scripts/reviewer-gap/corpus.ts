#!/usr/bin/env bun
/**
 * The frozen corpus: one record per cross-family review finding from the night
 * of 2026-10-29/30, and one per lane belief a measurement falsified.
 *
 * `corpus/SCHEMA.md` is the written schema; this file is the one that the tests
 * enforce. The field that drives the eval is `how_found_primary`: the strongest
 * thing the reviewer had to do to find the defect.
 *
 * Usage:
 *   bun scripts/reviewer-gap/corpus.ts            # distribution tables
 *   bun scripts/reviewer-gap/corpus.ts --json
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Weakest to strongest. `how_found_primary` is the strongest label a finding carries. */
export const HOW_FOUND = [
	"read-diff",
	"read-surrounding",
	"run-existing-tests",
	"historical-replay",
	"write-probe",
	"measure-timing",
	"inject-fault",
	"two-processes-barrier",
	"real-kernel-resource",
] as const;

export type HowFound = (typeof HOW_FOUND)[number];

export const SEVERITIES = ["P0", "P1", "P2", "P3", "unlabelled"] as const;

export interface CorpusFinding {
	id: string;
	pr: number;
	round: number;
	head_sha: string;
	severity: (typeof SEVERITIES)[number];
	title: string;
	files: string[];
	trigger: string;
	measured: string;
	closed: boolean;
	closed_at_sha: string | null;
	closed_round: number | null;
	closed_evidence: string | null;
	how_found_primary: HowFound;
	how_found: HowFound[];
	how_found_quote: string;
	report_path: string;
	report_lines: string;
}

export interface FalseBelief {
	id: string;
	pr: number;
	lane_report_path: string;
	lane_claim: string;
	claim_kind: string;
	falsified_by: string;
	falsifying_evidence: string;
	report_lines: string;
}

function readJsonl<T>(file: string): T[] {
	const out: T[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		out.push(JSON.parse(line) as T);
	}
	return out;
}

export function loadFindings(dir = path.join(import.meta.dir, "corpus", "findings")): CorpusFinding[] {
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.flatMap((f) => readJsonl<CorpusFinding>(path.join(dir, f)));
}

export function loadFalseBeliefs(dir = path.join(import.meta.dir, "corpus", "false-beliefs")): FalseBelief[] {
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.flatMap((f) => readJsonl<FalseBelief>(path.join(dir, f)));
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
	return out;
}

function main(): void {
	const findings = loadFindings();
	const beliefs = loadFalseBeliefs();
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify({ findings, beliefs }, null, 2));
		return;
	}
	const byHow = countBy(findings, (f) => f.how_found_primary);
	console.log(`${findings.length} findings over ${new Set(findings.map((f) => f.pr)).size} pull requests; ${beliefs.length} falsified lane beliefs\n`);
	console.log("| how_found_primary | findings | share |");
	console.log("|---|---:|---:|");
	for (const label of HOW_FOUND) {
		const n = byHow[label] ?? 0;
		if (n === 0) continue;
		console.log(`| ${label} | ${n} | ${((100 * n) / findings.length).toFixed(1)}% |`);
	}
	const readOnly = findings.filter((f) => f.how_found_primary === "read-diff" || f.how_found_primary === "read-surrounding").length;
	console.log(`\nfound without running anything: ${readOnly} / ${findings.length} (${((100 * readOnly) / findings.length).toFixed(1)}%)`);
	console.log("\n| severity | findings |");
	console.log("|---|---:|");
	for (const label of SEVERITIES) {
		const n = countBy(findings, (f) => f.severity)[label] ?? 0;
		if (n > 0) console.log(`| ${label} | ${n} |`);
	}
	console.log("\n| pull request | findings | closed by a later head |");
	console.log("|---|---:|---:|");
	for (const [pr, n] of Object.entries(countBy(findings, (f) => String(f.pr))).sort()) {
		const closed = findings.filter((f) => String(f.pr) === pr && f.closed).length;
		console.log(`| #${pr} | ${n} | ${closed} |`);
	}
	console.log("\n| falsified belief kind | count |");
	console.log("|---|---:|");
	for (const [kind, n] of Object.entries(countBy(beliefs, (b) => b.claim_kind)).sort()) console.log(`| ${kind} | ${n} |`);
}

if (import.meta.main) main();
