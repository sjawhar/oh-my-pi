import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

async function makeSandbox() {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-race-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

it("double run across many trials", async () => {
	const hist = new Map<number, number>();
	for (let i = 0; i < 200; i++) {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const leases = await Promise.all([1, 2, 3].map(n => leaseIsolationWorkspace(path.join(mergedDir, String(n)))));
		let runs = 0;
		await deferTeardownWhileLeased(mergedDir, async () => {
			runs += 1;
		});
		await Promise.all(leases.map(l => l()));
		hist.set(runs, (hist.get(runs) ?? 0) + 1);
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.log("teardown-run histogram (runs -> trials):", [...hist.entries()]);
});

it("lost teardown across many trials (dispose fire-and-forget, then owner defer)", async () => {
	const hist = new Map<string, number>();
	for (let i = 0; i < 200; i++) {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const lease = await leaseIsolationWorkspace(mergedDir);
		let runs = 0;
		void lease();
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => {
			runs += 1;
		});
		await Bun.sleep(5);
		const left = (await fs.readdir(path.join(baseDir, ISOLATION_LEASE_DIR)).catch(() => [])).length;
		const key = `deferred=${deferred} runs=${runs} leasesLeft=${left}`;
		hist.set(key, (hist.get(key) ?? 0) + 1);
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.log("outcomes:", [...hist.entries()]);
});
