import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const ROOT = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages";
const natives = await import(`${ROOT}/natives/native/index.js`);
const { Snowflake } = await import(`${ROOT}/utils/src/index.ts`);

const SRC = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src";
const lease = await import(`${SRC}/task/isolation-lease.ts`);
const own = await import(`${SRC}/task/isolation-ownership.ts`);
const wt = await import(`${SRC}/task/worktree.ts`);

const dirs: string[] = [];
async function mkSandbox(): Promise<{ root: string; base: string; merged: string; generation: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "probe-iso-")));
	dirs.push(root);
	const base = path.join(root, "tabc-1");
	const merged = path.join(base, "m");
	await fs.mkdir(merged, { recursive: true });
	const generation = await own.writeIsolationOwner(base, "Agent1");
	return { root, base, merged, generation };
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

test("P-A: a zero-byte entry in the lease dir pins the sandbox for ever", async () => {
	const { base } = await mkSandbox();
	// owner marker naming a dead pid
	await Bun.write(path.join(base, own.ISOLATION_OWNER_FILE), JSON.stringify({ pid: 999999, id: "x", generation: "g" }));
	await fs.mkdir(path.join(base, lease.ISOLATION_LEASE_DIR), { recursive: true });
	// what a SIGKILL between open(O_TRUNC) and write() in writeFileAtomically leaves behind
	await Bun.write(path.join(base, lease.ISOLATION_LEASE_DIR, "4242-1.json.4242.7.tmp"), "");
	console.log("hasLiveIsolationLease:", await lease.hasLiveIsolationLease(base));
	console.log("decideIsolationReclaim:", JSON.stringify(await own.decideIsolationReclaim(base)));
	const entries = await fs.readdir(path.join(base, lease.ISOLATION_LEASE_DIR));
	console.log("lease dir after check:", entries);
});

test("P-B: markUnfinishedWriter on a retiring sandbox succeeds (lease refuses)", async () => {
	const { base, merged } = await mkSandbox();
	await own.markIsolationRetiring(base);
	let leaseErr = "none";
	await lease.leaseIsolationWorkspace(merged).catch((e: Error) => (leaseErr = e.message));
	const clear = await lease.markUnfinishedWriter(merged);
	console.log("lease:", leaseErr);
	console.log("unfinished dir:", await fs.readdir(path.join(base, lease.ISOLATION_UNFINISHED_DIR)));
	await clear();
});

test("P-C: writer record taken during the teardown's locked window is deleted with the sandbox", async () => {
	const { base, merged, generation } = await mkSandbox();
	lease.registerIsolationWorkspace(merged, { baseDir: base, generation, agentId: "Agent1" });
	vi.spyOn(natives, "isoStop").mockResolvedValue(undefined as never);
	await Bun.write(path.join(merged, "work.txt"), "user work");
	let writerResult = "";
	let clearRecord: (() => Promise<void>) | undefined;
	const handle = { mergedDir: merged, generation, backend: natives.IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null };
	await wt.cleanupIsolation(handle, {
		capture: async () => {
			// A writer (e.g. the owner's own child session at beginDispose) records itself
			// while the teardown holds the lock, after hasUnfinishedWriter was asked.
			clearRecord = await lease.markUnfinishedWriter(merged);
			writerResult = "markUnfinishedWriter resolved (writer told it is protected)";
			await Bun.write(path.join(merged, "late.txt"), "written by protected writer");
		},
	});
	console.log(writerResult);
	console.log("base exists after cleanup:", await fs.exists(base));
	const siblings = await fs.readdir(path.dirname(base));
	console.log("siblings:", siblings);
	await clearRecord?.().catch((e: Error) => console.log("clear failed:", e.message));
});

test("P-D: markUnfinishedWriter racing a retire-rename recreates a ghost sandbox path", async () => {
	const { base, merged } = await mkSandbox();
	const real = Snowflake.next;
	let fired = false;
	vi.spyOn(Snowflake, "next").mockImplementation(() => {
		if (!fired) {
			fired = true;
			// teardown's rename lands between findSandboxBase and the write
			require("node:fs").renameSync(base, `${base}.retiring-x`);
		}
		return real.call(Snowflake);
	});
	const clear = await lease.markUnfinishedWriter(merged);
	vi.restoreAllMocks();
	console.log("ghost base exists:", await fs.exists(base));
	console.log("ghost contents:", await fs.readdir(base, { recursive: true }));
	console.log("ghost has marker:", await fs.exists(path.join(base, own.ISOLATION_OWNER_FILE)));
	await clear();
	console.log("after clear, ghost contents:", await fs.readdir(base, { recursive: true }).catch(() => "gone"));
});
