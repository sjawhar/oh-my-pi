import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import {
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	ensureIsolation,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

// Mirrors releaseIsolation (isolation-runner.ts:408-458): capture the delta, then cleanupHandle -> cleanupIsolation.
it("a leased descendant's writes after the owner's capture are deleted uncaptured", async () => {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	setWorktreesDir(await fs.mkdtemp(path.join(os.tmpdir(), "r3late-wt-")));
	delete process.env.OMP_WORKTREE_DIR;
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "r3late-repo-"));
	await git(r, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"]);

	const h = await ensureIsolation(r, "owner");
	const baseline = await captureIsolationBaseline(h.mergedDir, r);
	// Nested child inherits the sandbox cwd (structured-subagent.ts:880).
	const releaseLease = leaseIsolationWorkspace(h.mergedDir);
	await fs.writeFile(path.join(h.mergedDir, "early.txt"), "before owner release\n");

	// Owner's releaseIsolation: capture, then cleanup (deferred by the lease).
	const delta = await captureDeltaPatch(h.mergedDir, baseline);
	await cleanupIsolation(h);
	console.log("owner capture has early.txt:", delta.rootPatch.includes("early.txt"));

	// Descendant keeps working, as the lease says it may.
	await fs.writeFile(path.join(h.mergedDir, "late.txt"), "descendant work after owner release\n");
	console.log("late.txt exists while leased:", await Bun.file(path.join(h.mergedDir, "late.txt")).exists());

	releaseLease();
	await Bun.sleep(500);
	console.log("after last lease ends, sandbox exists:", await fs.stat(h.mergedDir).then(() => true, () => false));
	console.log("late.txt in any captured patch:", delta.rootPatch.includes("late.txt"));
});
