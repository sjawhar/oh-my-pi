import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import { hasLiveIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-ownership";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("a second process's ensureIsolation wipes a live owner's sandbox", async () => {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	const wt = await fs.mkdtemp(path.join(os.tmpdir(), "r3-wt-"));
	setWorktreesDir(wt);
	delete process.env.OMP_WORKTREE_DIR;
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "r3-repo-"));
	await git(r, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"]);

	// Process 1 (this one): a live run with uncommitted work in its sandbox.
	const a = await ensureIsolation(r, "AuthLoader");
	await fs.writeFile(path.join(a.mergedDir, "p1-work.txt"), "p1 uncaptured work\n");
	console.log("P1 pid", process.pid, "generation", a.generation, "live owner:", await hasLiveIsolationOwner(path.dirname(a.mergedDir)));

	// Process 2: another omp session in the same repo spawns a task with the same label.
	const child = Bun.spawn(
		["bun", "test", path.join(import.meta.dir, "r3-child.test.ts")],
		{
			cwd: "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent",
			env: { ...process.env, R3_WT: wt, R3_REPO: r, R3_ID: "AuthLoader" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	console.log((out + err).split("\n").filter(l => l.includes("CHILD") || l.includes("pass") || l.includes("fail")).join("\n"));

	console.log("P1 work file still there:", await Bun.file(path.join(a.mergedDir, "p1-work.txt")).exists());
	console.log("P1 sees P2's file in its own mergedDir:", await Bun.file(path.join(a.mergedDir, "p2-work.txt")).exists());
	await cleanupIsolation(a);
	console.log("after P1 cleanup, sandbox dir exists:", await fs.stat(a.mergedDir).then(() => true, () => false));
	console.log("wt root entries:", (await fs.readdir(wt)).sort());
});
