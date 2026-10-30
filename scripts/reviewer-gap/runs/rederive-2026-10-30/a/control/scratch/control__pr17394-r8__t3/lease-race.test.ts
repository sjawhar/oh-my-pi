import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

// Mirrors sdk.ts: session dispose fires `void workspaceLease()` and the
// lifecycle then calls onRelease -> releaseIsolation -> deferTeardownWhileLeased.
test("fire-and-forget lease release vs immediate deferral", async () => {
	let stuck = 0;
	let deferredRan = 0;
	let immediate = 0;
	const N = 200;
	for (let i = 0; i < N; i++) {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "lease-race-"));
		const merged = path.join(base, "m");
		await fs.mkdir(merged);
		await writeIsolationOwner(base, "t");
		registerIsolationWorkspace(merged);
		const lease = await leaseIsolationWorkspace(merged);
		let ran = false;
		const releasing = lease();
		const deferred = await deferTeardownWhileLeased(merged, async () => {
			ran = true;
		});
		await releasing;
		await Bun.sleep(5);
		if (!deferred) immediate++;
		else if (ran) deferredRan++;
		else stuck++;
		forgetIsolationWorkspace(merged);
		await fs.rm(base, { recursive: true, force: true });
	}
	console.log({ N, immediate, deferredRan, stuck });
});

// Foreign-process lease: owner defers, foreign holder releases; nothing runs teardown.
test("lease released by a process that did not materialise the sandbox never runs the owner's teardown", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "lease-foreign-"));
	const merged = path.join(base, "m");
	await fs.mkdir(merged);
	await writeIsolationOwner(base, "t");
	// "Foreign" holder: a lease taken while this process has no record of the workspace.
	const foreignRelease = await leaseIsolationWorkspace(merged);
	registerIsolationWorkspace(merged); // owner side
	let ran = false;
	const deferred = await deferTeardownWhileLeased(merged, async () => {
		ran = true;
	});
	await foreignRelease();
	await Bun.sleep(20);
	console.log({ deferred, teardownRan: ran, leaseDir: await fs.readdir(path.join(base, ".omp-isolation-leases")) });
	expect(deferred).toBe(true);
	expect(ran).toBe(false);
	forgetIsolationWorkspace(merged);
	await fs.rm(base, { recursive: true, force: true });
});
