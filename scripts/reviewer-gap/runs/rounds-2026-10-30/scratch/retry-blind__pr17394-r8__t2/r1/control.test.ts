import { afterEach, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";

const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24";
const { clearWorktrees } = await import(`${H}/packages/coding-agent/src/cli/worktree-cli.ts`);
const { deferTeardownWhileLeased, forgetIsolationWorkspace, leaseIsolationWorkspace, registerIsolationWorkspace } =
	await import(`${H}/packages/coding-agent/src/task/isolation-lease.ts`);
const { ISOLATION_OWNER_FILE, writeIsolationOwner } = await import(
	`${H}/packages/coding-agent/src/task/isolation-ownership.ts`
);
const { acquireFileLock, setWorktreesDir } = await import(`${H}/node_modules/@oh-my-pi/pi-utils`);

afterEach(() => setWorktreesDir(undefined));

it("P4 control: same scenario without a symlink — clear is excluded by the lock", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctl-"));
	const wt = path.join(root, "wt-real");
	await fs.mkdir(wt);
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wt);
	const base = path.join(wt, "t-deadbeef");
	await fs.mkdir(path.join(base, "m"), { recursive: true });
	await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ pid: 999999, id: "x", generation: "g" }));
	const held = await acquireFileLock(await fs.realpath(base), { retries: 1, retryDelayMs: 1 });
	const t0 = Date.now();
	const r = await clearWorktrees({ json: true } as never);
	console.log(`control clear: ${JSON.stringify(r)} in ${Date.now() - t0}ms; dir exists: ${await fs.stat(base).then(() => true, () => false)}`);
	held.release();
	await fs.rm(root, { recursive: true, force: true });
}, 20_000);

it("P3 more iterations", async () => {
	let lost = 0;
	let doubled = 0;
	const N = 300;
	for (let i = 0; i < N; i++) {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "race-"));
		const mergedDir = path.join(baseDir, "m");
		await fs.mkdir(mergedDir);
		await writeIsolationOwner(baseDir, "race");
		registerIsolationWorkspace(mergedDir);
		const user = await leaseIsolationWorkspace(mergedDir);
		let torndown = 0;
		const [deferred] = await Promise.all([
			deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1)),
			(async () => {
				if (i % 8) await scheduler.wait(i % 8);
				await user();
			})(),
		]);
		await scheduler.wait(15);
		const leases = await fs.readdir(path.join(baseDir, ".omp-isolation-leases"));
		if (deferred && torndown === 0 && leases.length === 0) lost += 1;
		if (torndown > 1) doubled += 1;
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.log(`lost teardown: ${lost}/${N}; doubled: ${doubled}/${N}`);
}, 60_000);
