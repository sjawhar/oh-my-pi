import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import fsDefault from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree.ts";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("C: worktree base reached through a symlink gets a different sandbox lock", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "probe-alias-repo-"));
	await git(repo, ["init", "-q", "-b", "main"]);
	await git(repo, ["config", "user.email", "a@b"]);
	await git(repo, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-qm", "init"]);
	const real = await fs.mkdtemp(path.join(os.tmpdir(), "probe-alias-wt-"));
	const link = `${real}-link`;
	await fs.symlink(real, link);
	delete process.env.OMP_WORKTREE_DIR;
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);

	// Run A: process configured with worktree.base = the symlink.
	setWorktreesDir(link);
	const a = await ensureIsolation(repo, "alias");

	// Pause A's teardown after its claim check, right at the retire rename.
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const realFile = Bun.file.bind(Bun);
	let armed = true;
	const spy = vi.spyOn(Bun, "file").mockImplementation(((p: string, o?: unknown) => {
		const f = realFile(p as never, o as never);
		if (!armed || !String(p).endsWith(".omp-isolation-owner.json")) return f;
		armed = false;
		return {
			json: async () => {
				const v = await f.json(); // claim read: A's own generation
				entered.resolve();
				await gate.promise; // stop between the check and the rename
				return v;
			},
		};
	}) as never);
	const teardown = cleanupIsolation(a);
	const won = await Promise.race([entered.promise.then(() => "rename-intercepted"), Bun.sleep(3000).then(() => "no-intercept")]);
	console.log("pause:", won);
	if (won !== "rename-intercepted") {
		spy.mockRestore();
		gate.resolve();
		await teardown;
		return;
	}

	// Run B: same id, worktree.base = the canonical path. Its lock name differs.
	setWorktreesDir(real);
	const t0 = performance.now();
	const b = await ensureIsolation(repo, "alias");
	console.log(`B materialised in ${Math.round(performance.now() - t0)}ms while A held its lock; B.mergedDir=${b.mergedDir}`);
	const live = path.join(b.mergedDir, "live.txt");
	await fs.writeFile(live, "B's work\n");
	gate.resolve();
	await teardown;
	console.log("B's live file after A's stale teardown:", await Bun.file(live).exists());
	console.log("B's sandbox dir exists:", await Bun.file(path.join(b.mergedDir, "a.txt")).exists());
});
