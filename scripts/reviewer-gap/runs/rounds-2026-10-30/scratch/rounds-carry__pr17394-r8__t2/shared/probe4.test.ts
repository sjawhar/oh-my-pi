import { afterEach, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

const cleanups: string[] = [];
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const d of cleanups.splice(0)) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function git(cwd: string, ...args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
async function makeRepo(): Promise<string> {
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "probe4-repo-"));
	cleanups.push(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "a@b");
	await git(repo, "config", "user.name", "a");
	await Bun.write(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "init");
	return repo;
}

async function run(withLease: boolean) {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	const repo = await makeRepo();
	const wt = await fsp.mkdtemp(path.join(os.tmpdir(), "probe4-wt-"));
	cleanups.push(wt);
	setWorktreesDir(wt);
	const artifactsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "probe4-art-"));
	cleanups.push(artifactsDir);
	const id = withLease ? "LeasedRel" : "PlainRel";
	let releaseLease: (() => Promise<void>) | undefined;
	let worktree = "";
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options: any) => {
		worktree = options.worktree;
		// The child did its work.
		await Bun.write(path.join(worktree, "work.txt"), "child work\n");
		if (withLease) {
			// A nested descendant inherited the cwd and is still alive.
			await fsp.mkdir(path.join(worktree, "nested"), { recursive: true });
			releaseLease = await leaseIsolationWorkspace(path.join(worktree, "nested"));
		}
		// The child's own teardown runs the release inside runSubprocess (refused adoption).
		await options.onRelease?.();
		return {
			index: 0, id: options.id, agent: "task", agentSource: "bundled", task: "t", assignment: "t",
			exitCode: 0, output: "done", stderr: "", truncated: false, durationMs: 1, tokens: 0, requests: 0,
		};
	});
	const res: any = await runIsolatedSubprocess({
		baseOptions: {
			cwd: repo,
			agent: { name: "task", description: "d", systemPrompt: "s", source: "bundled" },
			task: "t",
			index: 0,
			id,
		} as any,
		context: { repoRoot: repo },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "patch",
		artifactsDir,
		buildFailureResult: (e: unknown) => ({ exitCode: 1, error: String(e) }) as any,
	});
	console.error(
		`withLease=${withLease} returned result: patchPath=${res.patchPath} branchName=${res.branchName} exitCode=${res.exitCode} error=${res.error}`,
	);
	if (releaseLease) {
		await releaseLease();
		await scheduler.wait(1000);
	}
	const arts = await fsp.readdir(artifactsDir);
	const patches = await Promise.all(arts.map(a => Bun.file(path.join(artifactsDir, a)).text()));
	console.error(
		`withLease=${withLease} after lease end: artifacts=${JSON.stringify(arts)} patch mentions work.txt=${patches.some(p => p.includes("work.txt"))} workspace exists=${await fsp.exists(worktree)}`,
	);
}

it("release inside runSubprocess while a descendant holds a lease", async () => {
	await run(false);
	await run(true);
}, 60_000);
