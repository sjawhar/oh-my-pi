import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const lease = await import(`${HEAD}/task/isolation-lease.ts`);
const own = await import(`${HEAD}/task/isolation-ownership.ts`);

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) {
		await fs.chmod(path.join(d, ".omp-isolation-leases"), 0o755).catch(() => {});
		await fs.rm(d, { recursive: true, force: true });
	}
});

async function sandbox(): Promise<{ base: string; merged: string }> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "lease-probe-"));
	dirs.push(base);
	const merged = path.join(base, "m");
	await fs.mkdir(merged);
	await own.writeIsolationOwner(base, "probe");
	lease.registerIsolationWorkspace(merged);
	return { base, merged };
}

test("A: release racing deferral loses the teardown", async () => {
	const { base, merged } = await sandbox();
	const release = await lease.leaseIsolationWorkspace(merged);
	let ran = 0;
	const deferP = lease.deferTeardownWhileLeased(merged, async () => {
		ran++;
	});
	const relP = release();
	const [deferred] = await Promise.all([deferP, relP]);
	await Bun.sleep(200);
	const left = await fs.readdir(path.join(base, ".omp-isolation-leases"));
	console.log("A deferred=", deferred, "teardownRuns=", ran, "leasesLeft=", left);
	console.log("A live lease now?", await lease.hasLiveIsolationLease(base));
	lease.forgetIsolationWorkspace(merged);
});

test("B: two releases racing run the pending teardown twice", async () => {
	const { base, merged } = await sandbox();
	const r1 = await lease.leaseIsolationWorkspace(merged);
	const r2 = await lease.leaseIsolationWorkspace(merged);
	let ran = 0;
	const deferred = await lease.deferTeardownWhileLeased(merged, async () => {
		ran++;
		await Bun.sleep(50);
	});
	await Promise.all([r1(), r2()]);
	console.log("B deferred=", deferred, "teardownRuns=", ran);
	lease.forgetIsolationWorkspace(merged);
});

test("C: unreadable lease dir reads as no lease", async () => {
	const { base, merged } = await sandbox();
	const r = await lease.leaseIsolationWorkspace(merged);
	await fs.chmod(path.join(base, ".omp-isolation-leases"), 0o000);
	console.log("C hasLive with EACCES lease dir:", await lease.hasLiveIsolationLease(base));
	let ran = 0;
	console.log("C deferred:", await lease.deferTeardownWhileLeased(merged, async () => { ran++; }));
	await fs.chmod(path.join(base, ".omp-isolation-leases"), 0o755);
	await r();
	lease.forgetIsolationWorkspace(merged);
});

test("D: lease write failure (ENOSPC/EACCES) leaves the child unleased", async () => {
	const { base, merged } = await sandbox();
	await fs.mkdir(path.join(base, ".omp-isolation-leases"));
	await fs.chmod(path.join(base, ".omp-isolation-leases"), 0o500);
	const r = await lease.leaseIsolationWorkspace(merged);
	await fs.chmod(path.join(base, ".omp-isolation-leases"), 0o755);
	console.log("D hasLive after lease attempt:", await lease.hasLiveIsolationLease(base));
	console.log("D deferred:", await lease.deferTeardownWhileLeased(merged, async () => {}));
	await r();
	lease.forgetIsolationWorkspace(merged);
});

test("E: crashed writer's truncated tmp lease pins the sandbox forever", async () => {
	const { base } = await sandbox();
	const dir = path.join(base, ".omp-isolation-leases");
	await fs.mkdir(dir);
	await Bun.write(path.join(dir, "4242-1.json.4242-1.tmp"), '{"pid":42');
	console.log("E hasLive:", await lease.hasLiveIsolationLease(base));
	console.log("E reclaim:", JSON.stringify(await own.decideIsolationReclaim(base)));
});
