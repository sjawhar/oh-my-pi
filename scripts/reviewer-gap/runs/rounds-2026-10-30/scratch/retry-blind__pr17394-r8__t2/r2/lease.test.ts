import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease.ts";
import { decideIsolationReclaim, writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) {
		await fs.chmod(path.join(d, ISOLATION_LEASE_DIR), 0o755).catch(() => {});
		await fs.rm(d, { recursive: true, force: true });
	}
});

async function sandbox(): Promise<{ baseDir: string; mergedDir: string }> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-probe-"));
	dirs.push(baseDir);
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

test("cross-process lease: owner's deferred teardown after the other process leaves", async () => {
	const { mergedDir } = await sandbox();
	registerIsolationWorkspace(mergedDir);
	const child = Bun.spawn(["bun", path.join(import.meta.dir, "holder.ts"), mergedDir, "release"], {
		stdin: "pipe",
		stdout: "pipe",
	});
	const reader = child.stdout.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	console.log("child:", first.trim());
	let torndown = 0;
	const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1));
	console.log("deferred =", deferred);
	child.stdin.write("go\n");
	child.stdin.flush();
	await child.exited;
	await Bun.sleep(2000);
	console.log("other process exited code", child.exitCode, "; teardown runs after 2s =", torndown);
	console.log("lease files left:", await fs.readdir(path.join(path.dirname(mergedDir), ISOLATION_LEASE_DIR)));
});

test("in-process race: release lands while defer is deciding", async () => {
	let lost = 0;
	const N = 200;
	for (let i = 0; i < N; i++) {
		const { mergedDir } = await sandbox();
		registerIsolationWorkspace(mergedDir);
		const release = await leaseIsolationWorkspace(path.join(mergedDir, "nested"));
		let torndown = 0;
		const [deferred] = await Promise.all([
			deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1)),
			release(),
		]);
		await Bun.sleep(5);
		if (deferred && torndown === 0) lost += 1;
	}
	console.log(`in-process race: deferred-but-never-torn-down ${lost}/${N}`);
});

test("unreadable lease dir counts as no lease for clear", async () => {
	const { baseDir } = await sandbox();
	// Owner marker naming a dead pid, as left by a crashed owner while another session still works there.
	await Bun.write(path.join(baseDir, ".omp-isolation-owner.json"), JSON.stringify({ pid: 999999, id: "probe", generation: "x" }));
	const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
	await fs.mkdir(leaseDir, { recursive: true });
	await Bun.write(path.join(leaseDir, "live.json"), JSON.stringify({ pid: process.pid }));
	console.log("readable lease dir:", await decideIsolationReclaim(baseDir));
	await fs.chmod(leaseDir, 0o000);
	console.log("lease dir mode 000:", await decideIsolationReclaim(baseDir));
});
