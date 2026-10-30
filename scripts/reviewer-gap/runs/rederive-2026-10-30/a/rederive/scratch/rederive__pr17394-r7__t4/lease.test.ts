import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const CA = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent";
const r = (s: string) => Bun.resolveSync(s, CA);
const { leaseIsolationWorkspace } = await import(r("@oh-my-pi/pi-coding-agent/task/isolation-lease"));
const { cleanupIsolation, ensureIsolation } = await import(r("@oh-my-pi/pi-coding-agent/task/worktree"));
const natives = await import(r("@oh-my-pi/pi-natives"));
const { setWorktreesDir } = await import(r("@oh-my-pi/pi-utils"));

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await p.exited;
	if (code !== 0) throw new Error(await new Response(p.stderr).text());
}

async function setup(tag: string) {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `probe-repo-${tag}-`));
	await git(repo, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, ["add", "."]);
	await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
	const base = await fs.mkdtemp(path.join(os.tmpdir(), `probe-wt-${tag}-`));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(base);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	return repo;
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("old generation's teardown forgets the successor's lease registration", async () => {
	const repo = await setup("forget");
	const A = await ensureIsolation(repo, "same-id");
	// Hold A's teardown after the rename, inside isoStop.
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const realStop = natives.isoStop;
	const spy = vi.spyOn(natives, "isoStop").mockImplementation((async (b: never, m: string) => {
		if (m !== A.mergedDir) {
			entered.resolve();
			await gate.promise;
		}
		return realStop(b, m);
	}) as never);
	const aTeardown = cleanupIsolation(A);
	await entered.promise;
	// Window: the replacement spawn materialises the same id.
	const B = await ensureIsolation(repo, "same-id");
	console.log("A gen", A.generation, "B gen", B.generation, "same mergedDir", A.mergedDir === B.mergedDir);
	gate.resolve();
	await aTeardown;
	spy.mockRestore();

	// A nested child of B starts working in B's sandbox.
	const work = path.join(B.mergedDir, "child-work.txt");
	await fs.writeFile(work, "nested child output\n");
	const release = leaseIsolationWorkspace(B.mergedDir);
	// B's owner tears down: must defer while the lease is held.
	await cleanupIsolation(B);
	const survived = await Bun.file(work).exists();
	console.log("nested child's file survives B teardown while leased:", survived);
	release();
	expect(survived).toBe(true);
});

it("a lease taken while cleanup awaits the lock/claim read is ignored", async () => {
	const repo = await setup("window");
	const A = await ensureIsolation(repo, "window-id");
	const work = path.join(A.mergedDir, "child-work.txt");
	await fs.writeFile(work, "nested child output\n");
	const teardown = cleanupIsolation(A); // passes the lease check synchronously
	const release = leaseIsolationWorkspace(A.mergedDir); // nested child spawns now
	await teardown;
	const survived = await Bun.file(work).exists();
	console.log("file survives teardown although a lease is held:", survived);
	release();
	expect(survived).toBe(true);
});

it("control: without the racing old teardown, B's teardown defers on the lease", async () => {
	const repo = await setup("control");
	const B = await ensureIsolation(repo, "control-id");
	const work = path.join(B.mergedDir, "child-work.txt");
	await fs.writeFile(work, "nested child output\n");
	const release = leaseIsolationWorkspace(B.mergedDir);
	await cleanupIsolation(B);
	const survived = await Bun.file(work).exists();
	console.log("control survives:", survived);
	release();
	expect(survived).toBe(true);
});
