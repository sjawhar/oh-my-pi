import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree.ts";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease.ts";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

async function setup(tag: string) {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-repo-`));
	await git(repo, ["init", "-q", "-b", "main"]);
	await git(repo, ["config", "user.email", "a@b"]);
	await git(repo, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-qm", "init"]);
	const wtBase = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-wt-`));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtBase);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	return { repo, wtBase };
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("A: stale teardown's forgetIsolationWorkspace drops the successor's lease registration", async () => {
	const { repo } = await setup("forget");
	const h1 = await ensureIsolation(repo, "race");
	const realStop = natives.isoStop;
	const gate = Promise.withResolvers<void>();
	const stopEntered = Promise.withResolvers<void>();
	let calls = 0;
	vi.spyOn(natives, "isoStop").mockImplementation(async (kind, merged) => {
		if (calls++ === 0) {
			stopEntered.resolve();
			await gate.promise;
		}
		return await realStop(kind, merged);
	});
	const stale = cleanupIsolation(h1);
	await stopEntered.promise;
	// Replacement spawn for the same id materialises while the old teardown is in isoStop.
	const h2 = await ensureIsolation(repo, "race");
	console.log("same mergedDir:", h1.mergedDir === h2.mergedDir, "gens:", h1.generation, h2.generation);
	gate.resolve();
	await stale;
	// A nested child of the successor run starts working in its sandbox.
	const nested = path.join(h2.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "live descendant work\n");
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(h2); // owner teardown; must defer while the lease is held
	await scheduler.wait(50);
	console.log("descendant file exists while lease held:", await Bun.file(data).exists());
	release();
});

it("B: a teardown that keeps the lock makes a replacement materialisation throw after ~5s", async () => {
	const { repo } = await setup("lockbudget");
	const h1 = await ensureIsolation(repo, "budget");
	const baseDir = path.dirname(h1.mergedDir);
	// Make the retire rename fail (ENOTEMPTY) so cleanupIsolation takes the hold-the-lock branch.
	const target = `${baseDir}.retiring-${h1.generation}`;
	await fs.mkdir(path.join(target, "x"), { recursive: true });
	const realStop = natives.isoStop;
	vi.spyOn(natives, "isoStop").mockImplementation(async (kind, merged) => {
		await scheduler.wait(6000); // a slow unmount / large tree
		return await realStop(kind, merged);
	});
	const teardown = cleanupIsolation(h1);
	await scheduler.wait(100);
	const t0 = performance.now();
	let outcome: string;
	try {
		await ensureIsolation(repo, "budget");
		outcome = "materialised";
	} catch (err) {
		outcome = `threw: ${(err as Error).message}`;
	}
	console.log(`replacement after ${Math.round(performance.now() - t0)}ms -> ${outcome}`);
	await teardown;
}, 20000);
