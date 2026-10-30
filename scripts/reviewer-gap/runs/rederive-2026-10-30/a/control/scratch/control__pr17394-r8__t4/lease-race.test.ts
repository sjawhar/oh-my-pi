import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	hasLiveIsolationLease,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

async function sandbox(name: string) {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `lease-${name}-`)));
	const merged = path.join(base, "m");
	await fs.mkdir(merged, { recursive: true });
	await writeIsolationOwner(base, name);
	return { base, merged };
}

it("A: sdk-style `void release()` then owner release: teardown outcome", async () => {
	let lost = 0;
	let ran = 0;
	let immediate = 0;
	const N = 200;
	for (let i = 0; i < N; i++) {
		const { merged } = await sandbox(`a${i}`);
		registerIsolationWorkspace(merged);
		const release = await leaseIsolationWorkspace(merged);
		let tornDown = false;
		const teardown = async () => {
			tornDown = true;
		};
		// sdk.ts dispose: `disposeCallbacks.add(() => void workspaceLease())` — fire and forget,
		// then the lifecycle calls onRelease -> releaseIsolation -> deferTeardownWhileLeased.
		const releasing = release();
		const deferred = await deferTeardownWhileLeased(merged, teardown);
		await releasing;
		await Bun.sleep(5);
		if (!deferred) {
			immediate++;
			continue;
		}
		if (tornDown) ran++;
		else lost++;
	}
	console.log(JSON.stringify({ N, immediate, deferredThenRan: ran, deferredNeverRan: lost }));
});

it("B: lease held by a session whose cwd is found on disk (other process path): release never runs owner's pending teardown", async () => {
	const { base, merged } = await sandbox("b");
	// Owner registers (process A). Simulate process B: lease file written by findSandboxBase path.
	// We cannot unregister for a lease call only, so write B's lease by hand with a live pid (ours stands in for B).
	registerIsolationWorkspace(merged);
	const leaseDir = path.join(base, ".omp-isolation-leases");
	await fs.mkdir(leaseDir, { recursive: true });
	const otherLease = path.join(leaseDir, "other.json");
	await Bun.write(otherLease, JSON.stringify({ pid: process.pid }));
	let tornDown = false;
	const deferred = await deferTeardownWhileLeased(merged, async () => {
		tornDown = true;
	});
	// Process B releases: its closure has mergedDir === undefined, so it only removes the file.
	await fs.rm(otherLease);
	await Bun.sleep(50);
	console.log(JSON.stringify({ deferred, tornDownAfterOtherProcessRelease: tornDown, leaseLive: await hasLiveIsolationLease(base) }));
	expect(deferred).toBe(true);
});
