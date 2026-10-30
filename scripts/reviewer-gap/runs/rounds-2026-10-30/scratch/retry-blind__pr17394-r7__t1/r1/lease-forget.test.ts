import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { $ } from "bun";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";

async function mkRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await $`git init -q -b main ${repo}`.quiet();
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await $`git -C ${repo} -c user.email=a@b -c user.name=a add -A`.quiet();
	await $`git -C ${repo} -c user.email=a@b -c user.name=a commit -q -m init`.quiet();
	return repo;
}

it("stale teardown's forgetIsolationWorkspace erases the successor's lease registration", async () => {
	console.log("worktrees under", process.env.HOME);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	const repo = await mkRepo();
	const id = "same-id";
	const a = await ensureIsolation(repo, id);
	// Schedule control only: hold A's teardown between the rename (lock released) and forget.
	const gate = Promise.withResolvers<void>();
	const realStop = natives.isoStop;
	const stop = vi.spyOn(natives, "isoStop").mockImplementation(async (...args: Parameters<typeof realStop>) => {
		stop.mockRestore();
		await gate.promise;
		return realStop(...args);
	});
	const aTeardown = cleanupIsolation(a);
	await Bun.sleep(200);
	// Successor B claims the same path while A is still tearing down its retired copy.
	const b = await ensureIsolation(repo, id);
	console.log("B generation", b.generation, "A generation", a.generation);
	gate.resolve();
	await aTeardown;
	// A nested descendant of B starts working in B's sandbox.
	const nestedCwd = path.join(b.mergedDir, "sub");
	await fs.mkdir(nestedCwd, { recursive: true });
	const work = path.join(nestedCwd, "descendant-work.txt");
	await fs.writeFile(work, "nested child's in-progress work\n");
	const release = leaseIsolationWorkspace(nestedCwd);
	// B's owner tears down; the lease should defer it.
	await cleanupIsolation(b);
	const survives = await Bun.file(work).exists();
	console.log("descendant work survives B teardown while leased:", survives);
	release();
	expect(survives).toBe(true);
}, 30_000);

it("control: same sequence without the overlapping stale teardown keeps the lease", async () => {
	const repo = await mkRepo();
	const id = "same-id-control";
	const a = await ensureIsolation(repo, id);
	await cleanupIsolation(a);
	const b = await ensureIsolation(repo, id);
	const nestedCwd = path.join(b.mergedDir, "sub");
	await fs.mkdir(nestedCwd, { recursive: true });
	const work = path.join(nestedCwd, "descendant-work.txt");
	await fs.writeFile(work, "x\n");
	const release = leaseIsolationWorkspace(nestedCwd);
	await cleanupIsolation(b);
	console.log("control: descendant work survives while leased:", await Bun.file(work).exists());
	release();
	await Bun.sleep(300);
	console.log("control: after release, sandbox removed:", !(await Bun.file(work).exists()));
}, 30_000);

it("lock budget: teardown of a stale handle throws while a materialisation of the same id runs > 5s", async () => {
	const repo = await mkRepo();
	const id = "lock-budget";
	const a = await ensureIsolation(repo, id);
	const realStart = natives.isoStart;
	const start = vi.spyOn(natives, "isoStart").mockImplementation(async (...args: Parameters<typeof realStart>) => {
		start.mockRestore();
		await Bun.sleep(6_000); // a slow clone/copy of a large repo
		return realStart(...args);
	});
	const bPromise = ensureIsolation(repo, id);
	await Bun.sleep(100);
	const t0 = Date.now();
	const outcome = await cleanupIsolation(a).then(
		() => "resolved",
		(e: Error) => `rejected: ${e.message}`,
	);
	console.log(`stale cleanupIsolation after ${Date.now() - t0}ms ->`, outcome);
	await bPromise;
}, 30_000);
