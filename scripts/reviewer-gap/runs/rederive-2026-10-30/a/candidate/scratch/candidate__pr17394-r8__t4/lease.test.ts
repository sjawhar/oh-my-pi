import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	decideIsolationReclaim,
	ISOLATION_OWNER_FILE,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";

const dirs: string[] = [];
async function makeSandbox() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-"));
	dirs.push(root);
	const baseDir = path.join(root, "tabc");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	const generation = await writeIsolationOwner(baseDir, "probe");
	return { root, baseDir, mergedDir, generation };
}
afterEach(async () => {
	for (const d of dirs.splice(0)) {
		await fs.chmod(d, 0o700).catch(() => {});
		await Bun.$`chmod -R u+rwx ${d}`.quiet().nothrow();
		await fs.rm(d, { recursive: true, force: true });
	}
});

describe("probes", () => {
	it("P1: two leases released concurrently run the deferred teardown twice", async () => {
		const { mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const a = await leaseIsolationWorkspace(path.join(mergedDir, "x"));
		const b = await leaseIsolationWorkspace(path.join(mergedDir, "y"));
		let runs = 0;
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => {
			runs += 1;
		});
		await Promise.all([a(), b()]);
		console.log("P1 deferred:", deferred, "teardown runs:", runs);
		forgetIsolationWorkspace(mergedDir);
	});

	it("P2: unreadable lease dir reads as 'no lease' and the owner deletes", async () => {
		const { baseDir, mergedDir, generation } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const work = path.join(mergedDir, "child-work.txt");
		await fs.writeFile(work, "descendant data\n");
		const release = await leaseIsolationWorkspace(mergedDir);
		const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
		console.log("P2 leases on disk:", await fs.readdir(leaseDir));
		await fs.chmod(leaseDir, 0o000); // EACCES on readdir
		console.log("P2 hasLiveIsolationLease:", await hasLiveIsolationLease(baseDir));
		await cleanupIsolation({
			mergedDir,
			generation,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		} as never);
		console.log("P2 child's file still exists after owner teardown:", await Bun.file(work).exists());
		void release;
	});

	it("P3: lease write failure is swallowed; child gets a no-op release and teardown proceeds", async () => {
		const { baseDir, mergedDir, generation } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
		await fs.mkdir(leaseDir);
		await fs.chmod(leaseDir, 0o500); // EACCES on create
		const work = path.join(mergedDir, "child-work.txt");
		await fs.writeFile(work, "descendant data\n");
		const release = await leaseIsolationWorkspace(mergedDir);
		console.log("P3 lease call returned:", typeof release);
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => {});
		console.log("P3 owner sees lease (defers):", deferred);
		void release;
	});

	it("P4: a lease taken between the lease check and the rename is granted on a dying sandbox", async () => {
		const { baseDir, mergedDir, generation } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const realRename = fs.rename;
		let lateRelease: (() => Promise<void>) | undefined;
		const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(from) === baseDir && lateRelease === undefined) {
				// A nested child starts here: after deferTeardownWhileLeased said "no lease".
				lateRelease = await leaseIsolationWorkspace(path.join(mergedDir, "nested"));
				console.log("P4 leases on disk at rename time:", await fs.readdir(path.join(baseDir, ISOLATION_LEASE_DIR)));
			}
			return realRename(from as string, to as string);
		});
		try {
			await cleanupIsolation({
				mergedDir,
				generation,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			} as never);
		} finally {
			spy.mockRestore();
		}
		console.log("P4 mergedDir (child's cwd) exists after teardown:", await Bun.file(path.join(mergedDir, ".")).exists().catch(() => false), await fs.stat(mergedDir).then(() => true, () => false));
		// Lease written after the rename recreates the path
		const late = await leaseIsolationWorkspace(path.join(mergedDir, "nested2")).catch(e => String(e));
		console.log("P4 lease taken after teardown returned:", typeof late);
		const left = await fs.readdir(baseDir).catch(e => `ENOENT ${e.code}`);
		console.log("P4 baseDir contents after teardown + late lease:", left);
		console.log("P4 clear decision on leftover:", await decideIsolationReclaim(baseDir));
		await lateRelease?.();
	});
});
