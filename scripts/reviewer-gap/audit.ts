#!/usr/bin/env bun
/**
 * Diagnostics beside the score: did the arms behave differently, and is the
 * frozen rule or the reviewer the thing that rejected a finding?
 *
 * Nothing here decides a result. `grade.ts` does.
 *
 * Usage:
 *   bun scripts/reviewer-gap/audit.ts --runs <dir> [--cases <cases.json>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type CaseFile, detects, loadRuns, satisfiedGroups } from "./grade.ts";

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runsDir = get("--runs");
	if (runsDir === undefined) {
		console.error("usage: audit.ts --runs <dir> [--cases <cases.json>]");
		process.exit(2);
	}
	const cases = JSON.parse(
		fs.readFileSync(get("--cases") ?? path.join(import.meta.dir, "cases.json"), "utf8"),
	) as CaseFile;
	const runs = loadRuns(runsDir).filter(r => r.error === undefined);
	const findingsByHead = new Map<string, CaseFile["findings"]>();
	for (const f of cases.findings) findingsByHead.set(f.head, [...(findingsByHead.get(f.head) ?? []), f]);

	interface ArmAudit {
		runs: number;
		probeRuns: number;
		probeFiles: number;
		measuredRuns: number;
		reportChars: number;
		elapsedMs: number;
		detected: number;
		mechanismOnly: number;
		neither: number;
		n: number;
	}
	const arms = new Map<string, ArmAudit>();
	for (const run of runs) {
		const a = arms.get(run.arm) ?? {
			runs: 0,
			probeRuns: 0,
			probeFiles: 0,
			measuredRuns: 0,
			reportChars: 0,
			elapsedMs: 0,
			detected: 0,
			mechanismOnly: 0,
			neither: 0,
			n: 0,
		};
		a.runs++;
		a.reportChars += run.report.length;
		a.elapsedMs += run.elapsedMs;
		const scratch = path.join(runsDir, "scratch", run.runId);
		const probes = fs.existsSync(scratch) ? fs.readdirSync(scratch).filter(f => f.endsWith(".ts")) : [];
		a.probeFiles += probes.length;
		if (probes.length > 0) a.probeRuns++;
		// A report that quotes a command's output has measured something; a report
		// that only reasons about the code has not.
		if (/\bpass\b|\bfail\b|\d+ (pass|fail)|exit (code )?\d|\$ bun|bun test/i.test(run.report)) a.measuredRuns++;
		for (const f of findingsByHead.get(run.head) ?? []) {
			a.n++;
			if (detects(run.report, f, cases.window_chars)) {
				a.detected++;
				continue;
			}
			const s = satisfiedGroups(run.report, f);
			if (s.mechanism === s.mechanismTotal && s.trigger < s.triggerTotal) a.mechanismOnly++;
			else if (s.mechanism < s.mechanismTotal) a.neither++;
		}
		arms.set(run.arm, a);
	}

	console.log(
		"| arm | runs | runs that wrote a probe | probe files | runs quoting measured output | mean report chars | mean minutes |",
	);
	console.log("|---|---:|---:|---:|---:|---:|---:|");
	for (const [arm, a] of [...arms].sort()) {
		console.log(
			`| ${arm} | ${a.runs} | ${a.probeRuns} | ${a.probeFiles} | ${a.measuredRuns} | ${Math.round(a.reportChars / a.runs)} | ${(a.elapsedMs / a.runs / 60000).toFixed(1)} |`,
		);
	}
	console.log("\n| arm | n | detected | mechanism matched, trigger missing | mechanism missing |");
	console.log("|---|---:|---:|---:|---:|");
	for (const [arm, a] of [...arms].sort()) {
		console.log(`| ${arm} | ${a.n} | ${a.detected} | ${a.mechanismOnly} | ${a.neither} |`);
	}
}

if (import.meta.main) main();
