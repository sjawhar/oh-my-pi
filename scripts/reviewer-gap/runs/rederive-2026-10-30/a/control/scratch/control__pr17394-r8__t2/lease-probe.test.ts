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
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";
import { tryAcquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/utils/src/index";

async function makeSandbox() {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lease-probe-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

describe("probe", () => {
	it("two concurrent last-lease releases run the deferred teardown twice", async () => {
		let doubles = 0;
		const trials = 50;
		for (let i = 0; i < trials; i++) {
			const { baseDir, mergedDir } = await makeSandbox();
			registerIsolationWorkspace(mergedDir);
			const a = await leaseIsolationWorkspace(mergedDir);
			const b = await leaseIsolationWorkspace(mergedDir);
			let runs = 0;
			expect(await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1))).toBe(true);
			await Promise.all([a(), b()]);
			if (runs > 1) doubles++;
			forgetIsolationWorkspace(mergedDir);
			await fs.rm(baseDir, { recursive: true, force: true });
		}
		console.log(`double teardown in ${doubles}/${trials} trials`);
	});

	it("deferral racing the last release is a lost wakeup", async () => {
		let lost = 0;
		const trials = 50;
		for (let i = 0; i < trials; i++) {
			const { baseDir, mergedDir } = await makeSandbox();
			registerIsolationWorkspace(mergedDir);
			const a = await leaseIsolationWorkspace(mergedDir);
			let runs = 0;
			const [deferred] = await Promise.all([
				deferTeardownWhileLeased(mergedDir, async () => void (runs += 1)),
				a(),
			]);
			await Bun.sleep(5);
			if (deferred && runs === 0 && !(await hasLiveIsolationLease(baseDir))) lost++;
			forgetIsolationWorkspace(mergedDir);
			await fs.rm(baseDir, { recursive: true, force: true });
		}
		console.log(`lost wakeup (deferred=true, no lease left, teardown never ran) in ${lost}/${trials} trials`);
	});

	it("a lease released from another process never resumes the owner's teardown", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		const script = path.join(baseDir, "other.ts");
		await Bun.write(
			script,
			`import { leaseIsolationWorkspace } from ${JSON.stringify(path.join(process.cwd(), "src/task/isolation-lease.ts"))};
const release = await leaseIsolationWorkspace(${JSON.stringify(mergedDir)});
console.log("leased");
await Bun.sleep(300);
await release();
console.log("released");`,
		);
		const child = Bun.spawn(["bun", script], {
			cwd: path.resolve(import.meta.dir, "."),
			stdout: "pipe",
			env: { ...process.env },
		});
		// wait until the lease exists
		for (let i = 0; i < 100; i++) {
			const entries = await fs.readdir(path.join(baseDir, ISOLATION_LEASE_DIR)).catch(() => []);
			if (entries.length > 0) break;
			await Bun.sleep(20);
		}
		let runs = 0;
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
		await child.exited;
		console.log("child:", (await new Response(child.stdout).text()).trim().replace(/\n/g, " | "));
		await Bun.sleep(200);
		console.log(
			`deferred=${deferred} runs=${runs} leaseLive=${await hasLiveIsolationLease(baseDir)} dirExists=${await fs
				.stat(baseDir)
				.then(() => true)
				.catch(() => false)}`,
		);
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	});

	it("locks through a symlinked path do not exclude the realpath lock", async () => {
		const real = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lock-real-"));
		const link = `${real}-link`;
		await fs.symlink(real, link);
		const sandboxReal = path.join(real, "t-abc");
		const sandboxLink = path.join(link, "t-abc");
		await fs.mkdir(sandboxReal);
		const a = tryAcquireFileLock(sandboxReal);
		const b = tryAcquireFileLock(sandboxLink);
		console.log(`realpath lock held=${!!a}; symlinked-path lock also acquired=${!!b}`);
		a?.release();
		b?.release();
		await fs.rm(link);
		await fs.rm(real, { recursive: true, force: true });
	});
});
