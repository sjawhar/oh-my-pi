import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

// Same process: the owner's release asks "is it leased?" while the last lease
// holder (the child's own session dispose, `void workspaceLease()`) is leaving.
it("deferred teardown vs concurrent last-lease release", async () => {
	const tally = { deferredAndRan: 0, deferredAndLost: 0, notDeferred: 0 };
	for (let i = 0; i < 300; i += 1) {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lw-"));
		const mergedDir = path.join(baseDir, "m");
		await fs.mkdir(mergedDir, { recursive: true });
		await writeIsolationOwner(baseDir, "x");
		registerIsolationWorkspace(mergedDir);
		const release = await leaseIsolationWorkspace(mergedDir);
		let ran = 0;
		const delay = i % 6; // stagger the release start
		const deferP = deferTeardownWhileLeased(mergedDir, async () => void (ran += 1));
		for (let k = 0; k < delay; k += 1) await Bun.sleep(0);
		const relP = release();
		const [deferred] = await Promise.all([deferP, relP]);
		await Bun.sleep(5);
		if (!deferred) tally.notDeferred += 1;
		else if (ran > 0) tally.deferredAndRan += 1;
		else tally.deferredAndLost += 1;
		if (deferred && ran === 0 && tally.deferredAndLost === 1) {
			console.error(`first lost wakeup at i=${i} delay=${delay} liveLeaseNow=${await hasLiveIsolationLease(baseDir)}`);
		}
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.error(JSON.stringify(tally));
}, 60000);
