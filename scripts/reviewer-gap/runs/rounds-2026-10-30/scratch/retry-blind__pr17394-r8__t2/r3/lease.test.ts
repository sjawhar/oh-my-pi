import { expect, it } from "bun:test";
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

async function makeSandbox() {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

it("two leases released together run the deferred teardown how many times?", async () => {
	const { baseDir, mergedDir } = await makeSandbox();
	registerIsolationWorkspace(mergedDir);
	const a = await leaseIsolationWorkspace(path.join(mergedDir, "a"));
	const b = await leaseIsolationWorkspace(path.join(mergedDir, "b"));
	let runs = 0;
	console.log("deferred:", await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1)));
	await Promise.all([a(), b()]);
	console.log("teardown runs after concurrent release:", runs);
	forgetIsolationWorkspace(mergedDir);
	await fs.rm(baseDir, { recursive: true, force: true });
});

it("release racing the owner's defer: lost teardown?", async () => {
	let lost = 0;
	const trials = 40;
	for (let i = 0; i < trials; i++) {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const user = await leaseIsolationWorkspace(path.join(mergedDir, "x"));
		let runs = 0;
		const [deferred] = await Promise.all([
			deferTeardownWhileLeased(mergedDir, async () => void (runs += 1)),
			user(),
		]);
		await Bun.sleep(20);
		const stillLeased = await hasLiveIsolationLease(baseDir);
		if (deferred && runs === 0 && !stillLeased) lost += 1;
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.log(`lost teardowns (deferred=true, no lease left, teardown never ran): ${lost}/${trials}`);
});
