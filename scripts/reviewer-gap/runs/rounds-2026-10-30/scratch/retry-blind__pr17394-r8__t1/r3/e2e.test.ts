import { test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-"));
process.env.OMP_WORKTREE_DIR = path.join(root, "wt");
const wt = await import(`${HEAD}/task/worktree.ts`);
const lease = await import(`${HEAD}/task/isolation-lease.ts`);
const own = await import(`${HEAD}/task/isolation-ownership.ts`);

test("A2: child session lease released while cleanupIsolation decides -> sandbox never removed", async () => {
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await Bun.$`git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init`.cwd(repo);
	let lost = 0;
	let trials = 0;
	for (let i = 0; i < 40; i++) {
		const handle = await wt.ensureIsolation(repo, `agent-${i}`);
		// what sdk.ts:4478 does for the child session opened at the sandbox cwd
		const release = await lease.leaseIsolationWorkspace(handle.mergedDir);
		const cleanup = wt.cleanupIsolation(handle);
		const delayTicks = i;
		for (let t = 0; t < delayTicks; t++) await new Promise(r => setImmediate(r));
		await release(); // session dispose
		await cleanup;
		await Bun.sleep(50);
		trials++;
		const base = path.dirname(handle.mergedDir);
		if (await fs.exists(handle.mergedDir)) {
			lost++;
			if (lost === 1) {
				console.log("A2 first lost at ticks", delayTicks, "merged", handle.mergedDir);
				console.log("A2 leases:", await fs.readdir(path.join(base, ".omp-isolation-leases")));
				console.log("A2 clear decision:", JSON.stringify(await own.decideIsolationReclaim(base)));
			}
		}
	}
	console.log(`A2 sandboxes left on disk after cleanup+release: ${lost}/${trials}`);
	await fs.rm(root, { recursive: true, force: true });
}, 120_000);
