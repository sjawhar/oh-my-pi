import { afterEach, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	deferTeardownWhileLeased,
	hasLiveIsolationLease,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { decideIsolationReclaim, ISOLATION_OWNER_FILE } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

const cleanups: string[] = [];
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const d of cleanups.splice(0)) {
		await fsp.chmod(path.join(d), 0o755).catch(() => {});
		await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
	}
});

async function git(cwd: string, ...args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}
async function makeRepo(): Promise<string> {
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "probe2-repo-"));
	cleanups.push(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "a@b");
	await git(repo, "config", "user.name", "a");
	await Bun.write(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "init");
	return repo;
}
function rcopy() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}
async function deadPid() {
	const p = Bun.spawn(["true"]);
	await p.exited;
	return p.pid;
}
async function sandbox(id: string) {
	rcopy();
	const repo = await makeRepo();
	const wt = await fsp.mkdtemp(path.join(os.tmpdir(), "probe2-wt-"));
	cleanups.push(wt);
	setWorktreesDir(wt);
	return ensureIsolation(repo, id);
}

it("A: two leases released concurrently run the deferred teardown twice", async () => {
	const handle = await sandbox("dbl");
	const hist: Record<number, number> = {};
	for (let i = 0; i < 100; i++) {
		const l1 = await leaseIsolationWorkspace(handle.mergedDir);
		const l2 = await leaseIsolationWorkspace(path.join(handle.mergedDir, "sub"));
		let runs = 0;
		await deferTeardownWhileLeased(handle.mergedDir, async () => {
			runs += 1;
		});
		await Promise.all([l1(), l2()]);
		await scheduler.wait(5);
		hist[runs] = (hist[runs] ?? 0) + 1;
	}
	console.error("A histogram {teardownRuns: iterations} over 100:", JSON.stringify(hist));
}, 60_000);

it("B: dispose-then-onRelease ordering strands the teardown (void release, then defer)", async () => {
	const handle = await sandbox("ord");
	let stranded = 0;
	let ranLate = 0;
	let immediate = 0;
	const N = 200;
	for (let i = 0; i < N; i++) {
		const lease = await leaseIsolationWorkspace(handle.mergedDir);
		let ran = false;
		// sdk.ts:4479 `disposeCallbacks.add(() => void workspaceLease())`, then
		// agent-lifecycle.ts:666-672 `await live.dispose(); await onRelease()`.
		void lease();
		await Promise.resolve();
		const deferred = await deferTeardownWhileLeased(handle.mergedDir, async () => {
			ran = true;
		});
		await scheduler.wait(5);
		if (!deferred) immediate += 1;
		else if (ran) ranLate += 1;
		else stranded += 1;
	}
	console.error(
		`B N=${N} not-deferred=${immediate} deferred-and-ran=${ranLate} deferred-and-NEVER-ran=${stranded}`,
		"live lease now:",
		await hasLiveIsolationLease(path.dirname(handle.mergedDir)),
	);
}, 60_000);

it("C: a lease that cannot be written returns a no-op and the owner deletes the descendant's cwd", async () => {
	const handle = await sandbox("ro");
	const base = path.dirname(handle.mergedDir);
	const leaseDir = path.join(base, ISOLATION_LEASE_DIR);
	await fsp.mkdir(leaseDir, { recursive: true });
	await fsp.chmod(leaseDir, 0o555);
	const nested = path.join(handle.mergedDir, "nested");
	await fsp.mkdir(nested, { recursive: true });
	const release = await leaseIsolationWorkspace(nested);
	await Bun.write(path.join(nested, "work.txt"), "descendant work\n");
	console.error("C leaseIsolationWorkspace resolved (no throw); live lease:", await hasLiveIsolationLease(base));
	await cleanupIsolation(handle);
	console.error("C after owner teardown: descendant work exists:", await Bun.file(path.join(nested, "work.txt")).exists());
	await release();
}, 30_000);

it("D: a crashed lease writer's leftover temp file pins the sandbox forever", async () => {
	const base = await fsp.mkdtemp(path.join(os.tmpdir(), "probe2-d-"));
	cleanups.push(base);
	await fsp.mkdir(path.join(base, "m"), { recursive: true });
	const dead = await deadPid();
	await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ pid: dead, id: "x", generation: "g" }));
	const leaseDir = path.join(base, ISOLATION_LEASE_DIR);
	await fsp.mkdir(leaseDir, { recursive: true });
	// writeFileAtomically's temp name: `${file}.${pid}.${snowflake}.tmp`, left empty by SIGKILL between open and write.
	await Bun.write(path.join(leaseDir, `${dead}-123.json.${dead}.456.tmp`), "");
	console.error("D before:", JSON.stringify(await decideIsolationReclaim(base)));
	await scheduler.wait(1000);
	console.error("D 1s later (holder pid", dead, "dead):", JSON.stringify(await decideIsolationReclaim(base)), "entries:", await fsp.readdir(leaseDir));
}, 30_000);
