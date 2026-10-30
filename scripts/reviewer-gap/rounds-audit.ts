#!/usr/bin/env bun
/**
 * Per-round diagnostics beside the score: did a later round behave differently,
 * and did a carrying round actually use what it was handed?
 *
 * Nothing here decides a result. `rounds.ts` does, under the frozen rule.
 *
 * Usage:
 *   bun scripts/reviewer-gap/rounds-audit.ts --runs <dir>[,<dir>...]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type RoundRun, loadRoundRuns, toSequences } from "./rounds.ts";

/** Probe-like files a run left behind, excluding caches. */
function probeFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.name === "bun-cache" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|js|tsx|mjs|cjs|sh)$/.test(entry.name)) out.push(full);
		}
	};
	walk(dir);
	return out;
}

function main(): void {
	const argv = process.argv.slice(2);
	const i = argv.indexOf("--runs");
	const runsArg = i >= 0 ? argv[i + 1] : undefined;
	if (runsArg === undefined) {
		console.error("usage: rounds-audit.ts --runs <dir>[,<dir>...]");
		process.exit(2);
	}
	const dirs = runsArg.split(",");
	const runs = loadRoundRuns(dirs);
	const sequences = toSequences(runs);

	interface Cell {
		runs: number;
		chars: number;
		ms: number;
		promptChars: number;
		measured: number;
		reusedEarlierProbe: number;
		namedAnEarlierRound: number;
	}
	const cells: Record<string, Cell> = {};
	const probesBySequence: Record<string, number> = {};

	for (const seq of sequences) {
		// Both layouts live under <runs>/scratch/<sequence>; retry-blind keeps a
		// per-round subdirectory, rounds-carry one shared directory.
		let seqScratch = "";
		for (const dir of dirs) {
			const candidate = path.join(dir, "scratch", seq.id);
			if (fs.existsSync(candidate)) seqScratch = candidate;
		}
		const files = seqScratch === "" ? [] : probeFiles(seqScratch);
		probesBySequence[seq.id] = files.length;
		for (const run of seq.rounds) {
			const key = `${run.arm}__r${run.round ?? 1}`;
			const c = (cells[key] ??= {
				runs: 0,
				chars: 0,
				ms: 0,
				promptChars: 0,
				measured: 0,
				reusedEarlierProbe: 0,
				namedAnEarlierRound: 0,
			});
			c.runs++;
			c.chars += run.report.length;
			c.ms += run.elapsedMs;
			c.promptChars += (run as RoundRun & { promptChars?: number }).promptChars ?? 0;
			if (/\bpass\b|\bfail\b|\d+ (pass|fail)|exit (code )?\d|\$ bun|bun test/i.test(run.report)) c.measured++;
			if ((run.round ?? 1) > 1) {
				// A retry-blind round writes into its own `r<N>` subdirectory, so a
				// file it names in its own report is its own, not an earlier
				// round's; only files outside that subdirectory count as reuse.
				// rounds-carry shares one directory across rounds, so reuse there
				// cannot be attributed from the filesystem and is left at -1.
				const own = `${path.sep}r${run.round ?? 1}${path.sep}`;
				const earlier = files.filter(f => !f.includes(own)).map(f => path.basename(f));
				if (run.arm === "rounds-carry") c.reusedEarlierProbe = -1;
				else if (earlier.some(b => run.report.includes(b))) c.reusedEarlierProbe++;
				if (/round [12]\b|earlier round|previous round|prior round|earlier attempt|rounds 1/i.test(run.report))
					c.namedAnEarlierRound++;
			}
		}
	}

	console.log(
		"| arm | round | runs | mean report chars | mean prompt chars | mean minutes | quoted measured output | named an earlier round | named an earlier round's probe file |",
	);
	console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
	for (const [key, c] of Object.entries(cells).sort()) {
		const [arm, round] = key.split("__r") as [string, string];
		console.log(
			`| ${arm} | ${round} | ${c.runs} | ${Math.round(c.chars / c.runs)} | ${Math.round(c.promptChars / c.runs)} | ${(c.ms / c.runs / 60000).toFixed(1)} | ${c.measured} | ${round === "1" ? "-" : c.namedAnEarlierRound} | ${round === "1" ? "-" : c.reusedEarlierProbe < 0 ? "n/a (shared dir)" : c.reusedEarlierProbe} |`,
		);
	}

	console.log("\n| arm | sequences | probe files left per sequence |");
	console.log("|---|---:|---|");
	const byArm: Record<string, number[]> = {};
	for (const seq of sequences) (byArm[seq.arm] ??= []).push(probesBySequence[seq.id] ?? 0);
	for (const [arm, counts] of Object.entries(byArm).sort()) {
		const total = counts.reduce((a, b) => a + b, 0);
		console.log(`| ${arm} | ${counts.length} | total ${total}, mean ${(total / counts.length).toFixed(1)} |`);
	}
}

if (import.meta.main) main();
