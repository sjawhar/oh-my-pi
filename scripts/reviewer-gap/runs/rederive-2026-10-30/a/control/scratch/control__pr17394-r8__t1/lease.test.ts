import { afterEach, describe, expect, it } from "bun:test";
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

const dirs: string[] = [];
async function makeSandbox() {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-"));
	dirs.push(baseDir);
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("probe", () => {
	it("A: two concurrent in-process lease releases run the deferred teardown twice", async () => {
		const { mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		try {
			const a = await leaseIsolationWorkspace(path.join(mergedDir, "x"));
			const b = await leaseIsolationWorkspace(path.join(mergedDir, "y"));
			let runs = 0;
			expect(await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1))).toBe(true);
			await Promise.all([a(), b()]);
			console.log("A: teardown runs =", runs);
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("B: fire-and-forget release (sdk dispose) racing the owner's defer loses the teardown", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		try {
			const lease = await leaseIsolationWorkspace(mergedDir);
			let runs = 0;
			// session.dispose: `() => void workspaceLease()`, then lifecycle onRelease → defer
			void lease();
			const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
			await Bun.sleep(200);
			const left = await fs.readdir(path.join(baseDir, ISOLATION_LEASE_DIR)).catch(() => []);
			console.log("B: deferred =", deferred, "teardown runs =", runs, "leases left =", left.length);
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("C: lease held by another process: owner's deferred teardown never runs after it exits", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		try {
			const other = Bun.spawn(["sleep", "1"], { stdout: "ignore", stderr: "ignore" });
			await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, "other.json"), JSON.stringify({ pid: other.pid }));
			let runs = 0;
			const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
			await other.exited;
			// The other process's own release just rms its lease file (mergedDir undefined there → return).
			await fs.rm(path.join(baseDir, ISOLATION_LEASE_DIR, "other.json"), { force: true });
			await Bun.sleep(300);
			console.log("C: deferred =", deferred, "teardown runs =", runs);
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("D: unregistered sandbox: defer returns true and keeps nothing to run later", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, "me.json"), JSON.stringify({ pid: process.pid }));
		let runs = 0;
		const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
		await fs.rm(path.join(baseDir, ISOLATION_LEASE_DIR, "me.json"));
		console.log("D: deferred =", deferred, "runs =", runs);
	});
});
