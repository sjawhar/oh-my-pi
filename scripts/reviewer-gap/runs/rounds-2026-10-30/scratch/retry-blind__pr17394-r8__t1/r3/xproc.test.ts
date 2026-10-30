import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const lease = await import(`${HEAD}/task/isolation-lease.ts`);
const own = await import(`${HEAD}/task/isolation-ownership.ts`);
const utils = await import(`${HEAD}/../../utils/src/index.ts`);
const SCRATCH = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/retry-blind__pr17394-r8__t1/r3";

test("F: lease held by another process never runs the owner's deferred teardown", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "xproc-"));
	const merged = path.join(base, "m");
	await fs.mkdir(merged);
	await own.writeIsolationOwner(base, "probe");
	lease.registerIsolationWorkspace(merged);
	const go = path.join(base, "go");
	const child = Bun.spawn(["bun", path.join(SCRATCH, "child-lease.ts"), merged, go], { stdout: "pipe" });
	const reader = child.stdout.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	console.log("F child says:", first.trim());
	let ran = 0;
	const deferred = await lease.deferTeardownWhileLeased(merged, async () => {
		ran++;
	});
	await Bun.write(go, "");
	await child.exited;
	await Bun.sleep(300);
	console.log("F deferred=", deferred, "teardownRuns=", ran, "liveLease=", await lease.hasLiveIsolationLease(base));
	console.log("F reclaim decision:", JSON.stringify(await own.decideIsolationReclaim(base)));
	console.log("F sandbox still on disk:", await fs.exists(merged));
	lease.forgetIsolationWorkspace(merged);
	await fs.rm(base, { recursive: true, force: true });
});

test("E2: crashed lease writer's truncated tmp pins a dead owner's sandbox", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "tmppin-"));
	await fs.mkdir(path.join(base, "m"));
	await Bun.write(path.join(base, ".omp-isolation-owner.json"), JSON.stringify({ pid: 999999, id: "x", generation: "g" }));
	const dir = path.join(base, ".omp-isolation-leases");
	await fs.mkdir(dir);
	await Bun.write(path.join(dir, "4242-1.json.4242-7.tmp"), '{"pid":42');
	console.log("E2 reclaim:", JSON.stringify(await own.decideIsolationReclaim(base)));
	await fs.rm(path.join(dir, "4242-1.json.4242-7.tmp"));
	console.log("E2 reclaim w/o tmp:", JSON.stringify(await own.decideIsolationReclaim(base)));
	await fs.rm(base, { recursive: true, force: true });
});

test("G: clear's lock and ensureIsolation's lock differ under a symlinked worktree root", async () => {
	const real = await fs.mkdtemp(path.join(os.tmpdir(), "wtreal-"));
	const alias = `${real}-alias`;
	await fs.symlink(real, alias);
	const seg = "t-abc123456";
	await fs.mkdir(path.join(real, seg));
	// ensureIsolation: acquireFileLock(await resolveSandboxIdentity(getWorktreeDir(seg)))
	const wt = await import(`${HEAD}/task/worktree.ts`);
	const canon = await wt.resolveSandboxIdentity(path.join(alias, seg));
	const held = await utils.acquireFileLock(canon, { retries: 1 });
	console.log("G control: same canonical path lockable twice?", utils.tryAcquireFileLock(canon) !== null);
	// clear: acquireFileLock(target.path) where target.path = join(getWorktreesDir(), seg)
	const second = utils.tryAcquireFileLock(path.join(alias, seg));
	console.log("G canon=", canon, "aliasTarget=", path.join(alias, seg), "secondLockAcquiredWhileFirstHeld=", second !== null);
	second?.release();
	held.release();
	await fs.rm(alias);
	await fs.rm(real, { recursive: true, force: true });
});
