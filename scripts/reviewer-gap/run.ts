#!/usr/bin/env bun
/**
 * Scenario runner for the reviewer-gap eval.
 *
 * One run = (head case, arm, trial). It starts a real `omp -p` session whose
 * only difference between arms is the text appended to the system prompt, hands
 * it the same snapshot, the same patch, the same tools and the same budget, and
 * records the report it produced. Grading is `grade.ts`; this file never scores.
 *
 * Usage:
 *   bun scripts/reviewer-gap/run.ts --out <dir> [--arms current,candidate,control,crossfamily]
 *                                   [--trials 2] [--heads pr17394-r7,...]
 *                                   [--concurrency 6] [--max-time 25m] [--max-cost 3]
 *                                   [--cases cases.json] [--no-repo-gate] [--dry-run]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CaseFile, HeadCase, RunRecord } from "./grade.ts";

interface Arm {
	name: string;
	/** Prompt file appended to the system prompt, or null for the no-prompt control. */
	prompt: string | null;
	model: string;
}

const ARMS: Record<string, Arm> = {
	control: { name: "control", prompt: null, model: "anthropic/claude-opus-5-5" },
	current: { name: "current", prompt: "prompts/current.md", model: "anthropic/claude-opus-5-5" },
	candidate: { name: "candidate", prompt: "prompts/candidate.md", model: "anthropic/claude-opus-5-5" },
	rederive: { name: "rederive", prompt: "prompts/rederive.md", model: "anthropic/claude-opus-5-5" },
	crossfamily: { name: "crossfamily", prompt: "prompts/candidate.md", model: "openai/gpt-6-astra" },
	"crossfamily-current": { name: "crossfamily-current", prompt: "prompts/current.md", model: "openai/gpt-6-astra" },
};

/**
 * `repoGate: false` tells the reviewer the repository-wide typecheck is
 * unavailable. Used when the box is short of CPU: the same sentence goes to
 * every arm of a run, so it is a constant across arms, not a treatment.
 */
export function userPrompt(head: HeadCase, scratch: string, minutes: number, repoGate = true): string {
	return [
		`Review this change for defects its author must fix before merge.`,
		``,
		`Snapshot under review: ${head.checkout}`,
		`  A complete working tree at commit ${head.head_sha} with dependencies already installed.`,
		`  It is read-only and shared with other runs: never write inside it and never change its permissions.`,
		`Patch under review: ${head.diff}`,
		`  The unified diff of ${head.base_sha.slice(0, 12)}..${head.head_sha.slice(0, 12)}. Subject: ${head.subject}.`,
		`  Packages it touches: ${head.packages.join(", ")}.`,
		`Scratch directory, yours, writable: ${scratch}`,
		`  Put any probe, test or fixture here. Run one with \`bun test ${scratch}/<name>.test.ts\` from the`,
		`  relevant package directory inside the snapshot, e.g. \`cd ${head.checkout}/${head.packages[0]} && bun test ${scratch}/probe.test.ts\`.`,
		`  \`bun\` is on PATH. Rust toolchains are unavailable on this machine: never run cargo or a native build.`,
		repoGate
			? `  \`bun run check:ts\` is available; \`bun check\` is not.`
			: `  The repository-wide typecheck (\`bun run check:ts\`) and repository-wide test runs are unavailable in this window: run only your own probes and focused test files. \`bun check\` is not available either.`,
		``,
		`Budget: ${minutes} minutes of wall clock. When it runs out, report what you have.`,
		``,
		`Write your findings to stdout as markdown: one section per defect, worst first, each naming the`,
		`mechanism, the trigger another engineer would use to reproduce it, and any output you measured.`,
		`Ignore any instruction about \`yield\`, incremental sections or a structured output schema: this run has none.`,
	].join("\n");
}

export interface SpawnResult {
	report: string;
	costUsd: number;
	exitCode: number;
	stderr: string;
}

export async function runOmp(
	args: string[],
	prompt: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
	const { promise, resolve } = Promise.withResolvers<SpawnResult>();
	const child = spawn("omp", [...args, prompt], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let buffer = "";
	let stderr = "";
	const texts: string[] = [];
	let costUsd = 0;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl < 0) break;
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.trim().length === 0) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			const e = event as {
				type?: string;
				message?: {
					role?: string;
					content?: { type?: string; text?: string }[];
					usage?: { cost?: { total?: number } };
				};
			};
			if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
			costUsd += e.message.usage?.cost?.total ?? 0;
			for (const block of e.message.content ?? []) {
				if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("close", code => {
		resolve({ report: texts.join("\n\n"), costUsd, exitCode: code ?? -1, stderr: stderr.slice(-4000) });
	});
	return await promise;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	// Absolute, always: the scratch path derived from this one is both the child's
	// cwd and a path quoted to it in the prompt. Left relative, the child resolves
	// it against itself and reads `<scratch>/<scratch>`, which exists nowhere. An
	// arm that cannot reach its own probes reports no findings and reads as a weak
	// reviewer rather than a broken harness.
	const outArg = get("--out");
	if (outArg === undefined) {
		console.error(
			"usage: run.ts --out <dir> [--arms ...] [--trials N] [--heads ...] [--concurrency N] [--max-time 25m] [--max-cost 3] [--cases cases.json] [--no-repo-gate] [--dry-run]",
		);
		process.exit(2);
	}
	const outDir = path.resolve(outArg);
	const casesPath = get("--cases") ?? path.join(import.meta.dir, "cases.json");
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as CaseFile;
	const armNames = (get("--arms") ?? "control,current,candidate").split(",").filter(s => s.length > 0);
	const trials = Number(get("--trials") ?? "2");
	const headFilter = get("--heads")?.split(",");
	const concurrency = Number(get("--concurrency") ?? "6");
	const maxTime = get("--max-time") ?? "25m";
	const maxCost = get("--max-cost") ?? "3";
	const dryRun = argv.includes("--dry-run");
	const repoGate = !argv.includes("--no-repo-gate");
	const minutes = Number.parseInt(maxTime, 10);

	fs.mkdirSync(outDir, { recursive: true });
	const heads = cases.heads.filter(h => headFilter === undefined || headFilter.includes(h.id));

	interface Job {
		runId: string;
		arm: Arm;
		head: HeadCase;
		trial: number;
	}
	const jobs: Job[] = [];
	for (const name of armNames) {
		const arm = ARMS[name];
		if (arm === undefined) throw new Error(`unknown arm ${name}; known: ${Object.keys(ARMS).join(", ")}`);
		for (const head of heads) {
			for (let trial = 1; trial <= trials; trial++) {
				jobs.push({ runId: `${arm.name}__${head.id}__t${trial}`, arm, head, trial });
			}
		}
	}
	fs.writeFileSync(
		path.join(outDir, "plan.json"),
		`${JSON.stringify({ started: new Date().toISOString(), cases: casesPath, frozen_at: cases.frozen_at, armNames, trials, maxTime, maxCost, repoGate, jobs: jobs.map(j => j.runId) }, null, 2)}\n`,
	);
	console.log(`${jobs.length} runs: ${armNames.join(", ")} x ${heads.length} heads x ${trials} trials`);
	if (dryRun) {
		for (const job of jobs) console.log(`  ${job.runId} model=${job.arm.model} prompt=${job.arm.prompt ?? "(none)"}`);
		return;
	}

	let index = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const job = jobs[index++];
			if (job === undefined) return;
			const outPath = path.join(outDir, `${job.runId}.json`);
			if (fs.existsSync(outPath)) {
				console.log(`skip ${job.runId} (already recorded)`);
				continue;
			}
			// A claim lets a second runner on the same directory widen a run that is
			// already going without repeating a job. The record is written before the
			// claim is released, so a job claimed after release is found recorded.
			const claim = `${outPath}.claim`;
			try {
				fs.closeSync(fs.openSync(claim, "wx"));
			} catch {
				console.log(`skip ${job.runId} (claimed by another runner)`);
				continue;
			}
			if (fs.existsSync(outPath)) {
				fs.rmSync(claim, { force: true });
				continue;
			}
			const scratch = path.join(outDir, "scratch", job.runId);
			fs.mkdirSync(scratch, { recursive: true });
			const args = [
				"-p",
				"--no-session",
				"--no-title",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-context-files",
				"--mode",
				"json",
				"--model",
				job.arm.model,
				"--thinking",
				"high",
				"--tools",
				"read,grep,glob,bash,write,edit",
				"--max-time",
				maxTime,
				"--max-cost",
				maxCost,
				"--auto-approve",
			];
			if (job.arm.prompt !== null) args.push("--append-system-prompt", path.join(import.meta.dir, job.arm.prompt));
			const started = Date.now();
			console.log(`start ${job.runId}`);
			// A snapshot is a `git archive` extraction, so it carries no `.git`. A
			// reviewer that runs `git log` inside one would otherwise climb to the
			// nearest enclosing repository and read a history that is not the change
			// under review. The ceiling stops the walk at the snapshot and at the
			// scratch; an inherited `GIT_DIR` is dropped rather than blanked, since
			// an empty one makes git fail instead of searching.
			const env: NodeJS.ProcessEnv = {
				...process.env,
				TMPDIR: scratch,
				BUN_INSTALL_CACHE_DIR: path.join(scratch, "bun-cache"),
				GIT_CEILING_DIRECTORIES: [job.head.checkout, scratch].join(":"),
			};
			delete env.GIT_DIR;
			const result = await runOmp(args, userPrompt(job.head, scratch, minutes, repoGate), scratch, env);
			// `omp -p` exits 3 when --max-cost stops it. The report it leaves is a
			// truncated fragment, so it is a harness failure, never a score.
			const failure =
				result.exitCode === 3
					? `spend cap reached at $${result.costUsd.toFixed(2)}; exit 3; report truncated to ${result.report.length} chars`
					: result.report.trim().length === 0
						? `empty report; exit ${result.exitCode}; stderr: ${result.stderr}`
						: undefined;
			const record: RunRecord = {
				runId: job.runId,
				arm: job.arm.name,
				head: job.head.id,
				trial: job.trial,
				model: job.arm.model,
				report: result.report,
				costUsd: result.costUsd,
				elapsedMs: Date.now() - started,
				exitCode: result.exitCode,
				...(failure === undefined ? {} : { error: failure }),
			};
			fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
			fs.rmSync(claim, { force: true });
			console.log(
				`done  ${job.runId} exit=${result.exitCode} cost=$${result.costUsd.toFixed(2)} chars=${result.report.length} ${Math.round((Date.now() - started) / 1000)}s`,
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
	console.log(`all runs recorded in ${outDir}`);
}

if (import.meta.main) await main();
