import { test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SHARED = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r7__t2/shared";
const scratch = fs.mkdtempSync(path.join(SHARED, "r3r-"));
process.env.OMP_WORKTREE_DIR = path.join(scratch, "wt");

const SRC = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task";
const executorModule = await import(`${SRC}/executor.ts`);
const { runIsolatedSubprocess, mergeIsolatedChanges } = await import(`${SRC}/isolation-runner.ts`);

function makeRepo(name: string): string {
	const repo = path.join(scratch, name);
	fs.mkdirSync(repo, { recursive: true });
	const g = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: repo });
	g("init", "-q");
	fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
	g("add", ".");
	g("commit", "-qm", "init");
	return repo;
}

for (const mergeMode of ["branch", "patch"] as const) {
	test(`in-run release (refused adoption), mergeMode=${mergeMode}`, async () => {
		const repo = makeRepo(`repo-${mergeMode}`);
		const id = `InRun${mergeMode}`;
		const artifactsDir = path.join(scratch, `art-${mergeMode}`);
		fs.mkdirSync(artifactsDir, { recursive: true });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			// The child does work in the sandbox...
			fs.writeFileSync(path.join(options.worktree!, "work.txt"), "agent work\n");
			// ...then its own teardown runs onRelease inside runSubprocess (refused adoption).
			await options.onRelease?.();
			return {
				index: 0, id, agent: "task", agentSource: "bundled", task: "t", assignment: "t",
				exitCode: 0, output: "done", stderr: "", truncated: false, durationMs: 1, tokens: 0, requests: 0,
			} as never;
		});
		const result = await runIsolatedSubprocess({
			baseOptions: { cwd: repo, agent: { name: "task", description: "d", systemPrompt: "s", source: "bundled" }, task: "t", index: 0, id } as never,
			context: { repoRoot: repo } as never,
			preferredBackend: undefined,
			agentId: id,
			mergeMode,
			artifactsDir,
			buildFailureResult: e => ({ index: 0, id, exitCode: 1, error: String(e) }) as never,
		});
		console.log(`[${mergeMode}] result.branchName=${result.branchName} patchPath=${result.patchPath ? path.basename(result.patchPath) : undefined} error=${result.error}`);
		const outcome = await mergeIsolatedChanges({ result, repoRoot: repo, mergeMode } as never);
		console.log(`[${mergeMode}] merge summary=${JSON.stringify(outcome.summary)} changesApplied=${outcome.changesApplied}`);
		const branches = Bun.spawnSync(["git", "branch", "--list", "omp/task/*"], { cwd: repo }).stdout.toString().trim();
		console.log(`[${mergeMode}] task branches in parent repo: ${JSON.stringify(branches)}`);
		console.log(`[${mergeMode}] work.txt in parent working tree = ${fs.existsSync(path.join(repo, "work.txt"))}`);
		vi.restoreAllMocks();
	});
}
