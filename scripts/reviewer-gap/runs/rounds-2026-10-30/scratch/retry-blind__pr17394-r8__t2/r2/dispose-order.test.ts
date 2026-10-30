import { afterAll, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease.ts";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

// Mirrors sdk.ts:4479 `disposeCallbacks.add(() => void workspaceLease())` followed by
// finalizeSubagentLifecycle's `releaseOwnedResources()` -> releaseIsolation -> deferTeardownWhileLeased.
for (const gap of ["none", "microtask", "setImmediate"] as const) {
	test(`dispose (void release) then onRelease, gap=${gap}`, async () => {
		let lost = 0;
		let ranNow = 0;
		const N = 200;
		for (let i = 0; i < N; i++) {
			const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-order-"));
			dirs.push(baseDir);
			const mergedDir = path.join(baseDir, "m");
			await fs.mkdir(mergedDir, { recursive: true });
			await writeIsolationOwner(baseDir, "probe");
			registerIsolationWorkspace(mergedDir);
			const sessionLease = await leaseIsolationWorkspace(mergedDir);
			let torndown = 0;
			void sessionLease();
			if (gap === "microtask") await Promise.resolve();
			if (gap === "setImmediate") await new Promise(r => setImmediate(r));
			const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1));
			await Bun.sleep(5);
			if (!deferred) ranNow += 1;
			else if (torndown === 0) lost += 1;
		}
		console.log(`gap=${gap}: owner proceeds now ${ranNow}/${N}, deferred and never run ${lost}/${N}`);
	});
}
