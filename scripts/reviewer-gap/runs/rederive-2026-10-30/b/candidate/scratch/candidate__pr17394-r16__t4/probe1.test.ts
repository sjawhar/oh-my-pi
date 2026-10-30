import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	hasUnfinishedWriter,
	ISOLATION_LEASE_DIR,
	ISOLATION_UNFINISHED_DIR,
	leaseIsolationWorkspace,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	decideIsolationReclaim,
	resolveSandboxIdentity,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

async function makeSandbox(agentId = "owner") {
	const baseDir = await resolveSandboxIdentity(await fs.mkdtemp(path.join(os.tmpdir(), "omp-probe-")));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, agentId);
	return { baseDir, mergedDir };
}

afterEach(() => vi.restoreAllMocks());

it("P1 in-process lock exclusivity", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lock-"));
	const a = await acquireFileLock(dir, { retries: 600, retryDelayMs: 100 });
	let got = false;
	const b = acquireFileLock(dir, { retries: 600, retryDelayMs: 100 }).then(h => {
		got = true;
		return h;
	});
	await scheduler.wait(500);
	console.log("P1 second in-process acquire succeeded while first held:", got);
	a.release();
	(await b).release();
});

it("P2 failed writer record still drops lease; owner teardown runs under a live writer", async () => {
	const { baseDir, mergedDir } = await makeSandbox("owner");
	registerIsolationWorkspace(mergedDir, { baseDir, generation: "g1", agentId: "owner" });
	// A nested/foreign session in the sandbox (agent id != owner).
	const lease = await leaseIsolationWorkspace(path.join(mergedDir), { agentId: "nested" });
	let torndown = 0;
	const deferred = await deferTeardownWhileLeased(mergedDir, async () => {
		torndown += 1;
		await fs.rm(baseDir, { recursive: true, force: true });
	}, { generation: "g1" });
	console.log("P2 deferred while leased:", deferred);
	// Inject ENOSPC into the writer-record write (sdk.ts recordWriter -> markUnfinishedWriter).
	const realWrite = Bun.write;
	vi.spyOn(Bun, "write").mockImplementation(((dest: any, data: any) => {
		if (String(dest).includes(ISOLATION_UNFINISHED_DIR)) {
			const e: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device");
			e.code = "ENOSPC";
			return Promise.reject(e);
		}
		return (realWrite as any)(dest, data);
	}) as any);
	// Exactly sdk.ts:4589-4595: recordWriter().catch(log).finally(dropWorkspaceLease)
	let recordErr: unknown;
	await markUnfinishedWriter(mergedDir)
		.catch(e => {
			recordErr = e;
		})
		.finally(() => lease());
	vi.restoreAllMocks();
	await scheduler.wait(100);
	console.log("P2 record error:", String(recordErr));
	console.log("P2 teardown ran while writer still writing:", torndown, "baseDir exists:", await fs.exists(baseDir));
	forgetIsolationWorkspace(mergedDir);
});

it("P3 crashed atomic write leaves an empty .tmp in lease dir -> sandbox pinned forever", async () => {
	const { baseDir, mergedDir } = await makeSandbox("owner");
	// what writeFileAtomically leaves when the process is SIGKILLed between open(O_TRUNC) and rename
	const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
	await fs.mkdir(leaseDir, { recursive: true });
	await Bun.write(path.join(leaseDir, `999999-1.json.999999.1.tmp`), "");
	// owner process dead -> mark owner as dead pid
	await Bun.write(path.join(baseDir, ".omp-isolation-owner.json"), JSON.stringify({ pid: 999999, id: "x", generation: "g" }));
	console.log("P3 live lease:", await hasLiveIsolationLease(baseDir));
	console.log("P3 reclaim decision:", JSON.stringify(await decideIsolationReclaim(baseDir)));
	void mergedDir;
});
