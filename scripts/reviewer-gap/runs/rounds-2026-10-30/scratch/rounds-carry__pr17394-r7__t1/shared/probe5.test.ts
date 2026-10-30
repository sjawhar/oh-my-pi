import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";
async function git(cwd: string, args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});
it("replacement materialisation wipes a still-leased sandbox", async () => {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	setWorktreesDir(await fs.mkdtemp(path.join(os.tmpdir(), "probe5-wt-")));
	delete process.env.OMP_WORKTREE_DIR;
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "probe5-repo-"));
	await git(r, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"]);
	const a = await ensureIsolation(r, "same-id");
	const nested = path.join(a.mergedDir, "nested");
	await fs.mkdir(nested);
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "work\n");
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(a);
	console.log("after A cleanup (deferred by lease):", await Bun.file(data).exists());
	const b = await ensureIsolation(r, "same-id");
	console.log("after replacement ensureIsolation:", await Bun.file(data).exists(), "same mergedDir:", b.mergedDir === a.mergedDir);
	release();
	await Bun.sleep(300);
	console.log("B workspace entries after descendant's lease ends:", await fs.readdir(b.mergedDir).then(e => e.length, e => String(e.code)));
});
