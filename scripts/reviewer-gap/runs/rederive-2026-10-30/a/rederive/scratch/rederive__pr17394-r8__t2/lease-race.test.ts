import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease.ts";
import { writeIsolationOwner, writeProcessIdentity } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership.ts";

async function makeSandbox() {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

describe("probes", () => {
	it("A: defer vs concurrent last-lease release strands the teardown", async () => {
		let stranded = 0;
		const trials = 40;
		for (let t = 0; t < trials; t++) {
			const { baseDir, mergedDir } = await makeSandbox();
			registerIsolationWorkspace(mergedDir);
			const release = await leaseIsolationWorkspace(path.join(mergedDir, "x"));
			// Dead-holder leases lengthen hasLiveIsolationLease's walk (T1..T2).
			const dead = Bun.spawn(["true"]);
			await dead.exited;
			for (let i = 0; i < 50; i++) {
				await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, `dead-${i}.json`), JSON.stringify({ pid: dead.pid }));
			}
			let torn = 0;
			const deferred = deferTeardownWhileLeased(mergedDir, async () => void (torn += 1));
			await Bun.sleep(t % 10);
			const released = release();
			const [wasDeferred] = await Promise.all([deferred, released]);
			await Bun.sleep(5);
			const stillLeased = await hasLiveIsolationLease(baseDir);
			if (wasDeferred && torn === 0 && !stillLeased) stranded += 1;
			forgetIsolationWorkspace(mergedDir);
			await fs.rm(baseDir, { recursive: true, force: true });
		}
		console.log(`A: stranded teardowns ${stranded}/${trials}`);
	});

	it("B: two leases released together run the pending teardown twice", async () => {
		let doubled = 0;
		const trials = 40;
		for (let t = 0; t < trials; t++) {
			const { baseDir, mergedDir } = await makeSandbox();
			registerIsolationWorkspace(mergedDir);
			const a = await leaseIsolationWorkspace(mergedDir);
			const b = await leaseIsolationWorkspace(mergedDir);
			let torn = 0;
			expect(await deferTeardownWhileLeased(mergedDir, async () => void (torn += 1))).toBe(true);
			await Promise.all([a(), b()]);
			if (torn > 1) doubled += 1;
			forgetIsolationWorkspace(mergedDir);
			await fs.rm(baseDir, { recursive: true, force: true });
		}
		console.log(`B: teardown ran >1 times in ${doubled}/${trials}`);
	});

	it("C: lease held by another process never fires the owner's deferred teardown", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		// Another process opens a session in the sandbox and takes a lease.
		const holder = Bun.spawn(
			[
				"bun",
				"-e",
				`const { leaseIsolationWorkspace } = await import(${JSON.stringify(
					path.resolve("src/task/isolation-lease.ts"),
				)}); const r = await leaseIsolationWorkspace(${JSON.stringify(path.join(mergedDir, "sub"))}); console.log("leased"); await Bun.sleep(800); await r(); console.log("released");`,
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		await Bun.sleep(400);
		let torn = 0;
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (torn += 1));
		const out = await new Response(holder.stdout).text();
		await holder.exited;
		await Bun.sleep(1500);
		console.log(
			`C: holder said ${JSON.stringify(out.trim())}; deferred=${deferred}; liveLease=${await hasLiveIsolationLease(baseDir)}; teardown runs=${torn}`,
		);
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	});
});
