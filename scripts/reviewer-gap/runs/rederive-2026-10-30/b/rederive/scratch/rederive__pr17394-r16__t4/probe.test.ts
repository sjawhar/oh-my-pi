import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/utils/src/index.ts";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	hasUnfinishedWriter,
	ISOLATION_UNFINISHED_DIR,
	leaseIsolationWorkspace,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease.ts";
import {
	readIsolationClaim,
	resolveSandboxIdentity,
	SANDBOX_LOCK_WAIT,
	writeIsolationOwner,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership.ts";

const tmp: string[] = [];
const reg: string[] = [];
async function makeSandbox(agentId: string) {
	const baseDir = await resolveSandboxIdentity(await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-")));
	tmp.push(baseDir);
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	const generation = await writeIsolationOwner(baseDir, agentId);
	reg.push(mergedDir);
	return { baseDir, mergedDir, generation };
}
afterEach(async () => {
	for (const m of reg.splice(0)) forgetIsolationWorkspace(m);
	for (const d of tmp.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

// sdk.ts:4496 leases sessionManager.getCwd() at T1; sdk.ts:4506 re-derives the
// sandbox from sessionManager.getCwd() at T2 (disposal). Model the cwd as a
// mutable variable exactly as SessionManager.#cwd is.
for (const moved of [false, true]) {
	it(`writer record follows the lease (cwd moved: ${moved})`, async () => {
		const { baseDir, mergedDir, generation } = await makeSandbox("owner-task");
		registerIsolationWorkspace(mergedDir, { baseDir, generation, agentId: "owner-task" });
		let cwd = path.join(mergedDir, "sub");
		await fs.mkdir(cwd, { recursive: true });
		const getCwd = () => cwd;

		// T1: session creation
		const workspaceLease = await leaseIsolationWorkspace(getCwd(), { agentId: "nested-child" });
		// Owner finishes and asks to tear down; deferred because the session holds the lease.
		let torndown = 0;
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1), { generation });
		console.log("deferred while leased:", deferred);

		// In the window: session cwd changes (SessionManager move / setCwdWithoutRelocation).
		if (moved) cwd = await fs.mkdtemp(path.join(os.tmpdir(), "probe-elsewhere-"));

		// T2: disposal grace path: recordWriter() then dropWorkspaceLease()
		const clear = await markUnfinishedWriter(getCwd());
		await workspaceLease();
		console.log(
			`moved=${moved} writerRecordInLeasedSandbox=${await hasUnfinishedWriter(baseDir)} leaseLive=${await hasLiveIsolationLease(baseDir)} ownerTeardownRan=${torndown}`,
		);
		await clear();
		if (moved) await fs.rm(cwd, { recursive: true, force: true });
	});
}

// leaseIsolationWorkspace: findSandboxBase sees generation G1 (T1); under the
// lock it only checks kind === "claimed" (T2), not that it is still G1.
it("lease granted on a re-materialised generation", async () => {
	const { baseDir, mergedDir, generation: g1 } = await makeSandbox("task-a");
	const cwd = mergedDir;
	const held = await acquireFileLock(baseDir, SANDBOX_LOCK_WAIT);
	const leasing = leaseIsolationWorkspace(cwd, { agentId: "s" });
	await Bun.sleep(50); // lease has passed findSandboxBase(G1) and is waiting for the lock
	const g2 = await writeIsolationOwner(baseDir, "task-a"); // re-materialisation under the lock
	held.release();
	const release = await leasing;
	const claim = await readIsolationClaim(baseDir);
	console.log(`g1=${g1} g2=${g2} claimAtGrant=${JSON.stringify(claim)} leaseLive=${await hasLiveIsolationLease(baseDir)}`);
	await release();
});

// sdk.ts:4589-4595: recordWriter() rejects, the rejection is logged, the lease is dropped anyway.
it("writer record fails, lease still dropped (sdk glue)", async () => {
	const { baseDir, mergedDir, generation } = await makeSandbox("owner-task");
	registerIsolationWorkspace(mergedDir, { baseDir, generation, agentId: "owner-task" });
	const lease = await leaseIsolationWorkspace(mergedDir, { agentId: "nested-child" });
	let torndown = 0;
	await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1), { generation });
	const recDir = path.join(baseDir, ISOLATION_UNFINISHED_DIR);
	await fs.mkdir(recDir);
	await fs.chmod(recDir, 0o555); // record write fails (EACCES), listing still works
	let recordError = "";
	await markUnfinishedWriter(mergedDir)
		.catch(e => void (recordError = String(e)))
		.finally(() => lease());
	await Bun.sleep(50);
	console.log(`recordError=${recordError.slice(0, 60)} ownerTeardownRan=${torndown}`);
});
