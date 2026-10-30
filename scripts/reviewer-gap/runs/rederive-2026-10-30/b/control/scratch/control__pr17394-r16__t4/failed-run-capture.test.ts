import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as executorModule from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/executor";
import { runIsolatedSubprocess } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-runner";
import * as worktreeModule from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/worktree";

afterEach(() => vi.restoreAllMocks());

async function run(exitCode: number, mergeMode: "patch" | "branch") {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-"));
	const baseline = {
		root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	};
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: "/repo/isolated",
		generation: "g",
		backend: 0 as never,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
	const cleanups: string[] = [];
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async (_h, options) => {
		cleanups.push(options?.capture ? "with-capture" : "plain");
		await options?.capture?.();
	});
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
		rootPatch: "diff --git a/x b/x\n+half-done\n",
		nestedPatches: [],
	});
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
		branchName: "omp/task/T",
		baseSha: "base",
		rootPatch: "x",
		nestedPatches: [],
	});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => ({
		index: 0,
		id: options.id,
		agent: "task",
		agentSource: "bundled",
		task: "t",
		assignment: "t",
		exitCode,
		output: "",
		stderr: "boom",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	}));
	const out = await runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "d", systemPrompt: "s", source: "bundled" },
			task: "t",
			index: 0,
			id: `T${exitCode}${mergeMode}`,
			keepAlive: false,
		},
		context: { repoRoot: "/repo" },
		preferredBackend: undefined,
		agentId: `T${exitCode}${mergeMode}`,
		mergeMode,
		artifactsDir,
		buildFailureResult: error => ({ exitCode: 1, error: String(error) }) as never,
	});
	const files = await fs.readdir(artifactsDir);
	return { cleanups, commits: commitSpy.mock.calls.length, files, exitCode: out.exitCode };
}

it("failed one-shot patch-mode run", async () => {
	console.log("failed/patch", JSON.stringify(await run(1, "patch")));
});
it("successful one-shot patch-mode run", async () => {
	console.log("ok/patch", JSON.stringify(await run(0, "patch")));
});
it("successful one-shot branch-mode run", async () => {
	console.log("ok/branch", JSON.stringify(await run(0, "branch")));
});
