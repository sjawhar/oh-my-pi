import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/utils/src/file-lock";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import {
	decideIsolationReclaim,
	writeIsolationOwner,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent";

async function sandbox(): Promise<{ root: string; base: string; merged: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lease-probe-")));
	const base = path.join(root, "t-abc");
	const merged = path.join(base, "m");
	await fs.mkdir(merged, { recursive: true });
	await writeIsolationOwner(base, "task-1");
	return { root, base, merged };
}

test("A: race — lease released (void, as sdk dispose does) while owner defers teardown", async () => {
	let lost = 0;
	let ran = 0;
	const N = 200;
	for (let i = 0; i < N; i++) {
		const { merged } = await sandbox();
		registerIsolationWorkspace(merged);
		const release = await leaseIsolationWorkspace(merged);
		let teardownRan = false;
		// sdk.ts:4479 `disposeCallbacks.add(() => void workspaceLease())`, then
		// agent-lifecycle release awaits onRelease -> releaseIsolation -> deferTeardownWhileLeased
		void release();
		const deferred = await deferTeardownWhileLeased(merged, async () => {
			teardownRan = true;
		});
		await Bun.sleep(5);
		if (deferred && !teardownRan) lost++;
		if (teardownRan) ran++;
		forgetIsolationWorkspace(merged);
	}
	console.log(`A: iterations=${N} deferred-and-never-run=${lost} deferred-then-run=${ran}`);
});

test("B: lease released from another process never runs the owner's deferred teardown", async () => {
	const { base, merged } = await sandbox();
	registerIsolationWorkspace(merged);
	const script = path.join(path.dirname(import.meta.path), "child-lease.ts");
	const child = Bun.spawn(["bun", script, merged], { cwd: HEAD, stdin: "pipe", stdout: "pipe" });
	const reader = child.stdout.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	console.log(`B: child says: ${first.trim()}`);
	let teardownRan = false;
	const deferred = await deferTeardownWhileLeased(merged, async () => {
		teardownRan = true;
	});
	child.stdin.write("go\n");
	child.stdin.end();
	await child.exited;
	await Bun.sleep(1000);
	const leases = await fs.readdir(path.join(base, ".omp-isolation-leases"));
	console.log(
		`B: deferred=${deferred} teardownRanAfterChildReleasedAndExited=${teardownRan} leaseFilesLeft=${leases.length} hasLiveLease=${await hasLiveIsolationLease(base)} mergedStillExists=${await Bun.file(path.join(merged, ".")).exists().catch(() => "?")} ${(await fs.stat(merged).then(() => true, () => false))}`,
	);
	forgetIsolationWorkspace(merged);
});

test("C: lease through a symlink alias in the same process never runs the deferred teardown", async () => {
	const { root, merged } = await sandbox();
	registerIsolationWorkspace(merged);
	const alias = `${root}-alias`;
	await fs.symlink(root, alias);
	const release = await leaseIsolationWorkspace(path.join(alias, "t-abc", "m"));
	let teardownRan = false;
	const deferred = await deferTeardownWhileLeased(merged, async () => {
		teardownRan = true;
	});
	await release();
	await Bun.sleep(100);
	console.log(`C: deferred=${deferred} teardownRanAfterRelease=${teardownRan}`);
	forgetIsolationWorkspace(merged);
});

test("D: a lease dir readdir error (EACCES) reads as 'no lease' — owner tears down / clear reclaims", async () => {
	const { base, merged } = await sandbox();
	registerIsolationWorkspace(merged);
	const release = await leaseIsolationWorkspace(merged);
	const leaseDir = path.join(base, ".omp-isolation-leases");
	await fs.chmod(leaseDir, 0o300); // writable+exec, not readable
	const live = await hasLiveIsolationLease(base);
	const deferred = await deferTeardownWhileLeased(merged, async () => {});
	await fs.chmod(leaseDir, 0o700);
	console.log(`D: uid=${process.getuid?.()} liveLeaseHeld=true hasLiveIsolationLease=${live} deferTeardownWhileLeased=${deferred}`);
	await release();
	forgetIsolationWorkspace(merged);
});

test("E: lock via OMP_WORKTREE_DIR alias does not exclude the realpath lock ensureIsolation takes", async () => {
	const { root, base } = await sandbox();
	const alias = `${root}-alias2`;
	await fs.symlink(root, alias);
	const real = await acquireFileLock(base, { retries: 1 });
	let aliasAcquired = false;
	try {
		const other = await acquireFileLock(path.join(alias, "t-abc"), { retries: 1 });
		aliasAcquired = true;
		other.release();
	} catch (e) {
		aliasAcquired = false;
	}
	real.release();
	console.log(`E: realLockHeld=true aliasLockAcquiredConcurrently=${aliasAcquired}`);
	console.log(`E: decide=${JSON.stringify(await decideIsolationReclaim(path.join(alias, "t-abc")))}`);
});
