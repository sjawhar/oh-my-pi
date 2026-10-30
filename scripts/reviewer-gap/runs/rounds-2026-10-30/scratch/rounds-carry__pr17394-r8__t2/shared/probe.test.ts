import { afterEach, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { leaseIsolationWorkspace, hasLiveIsolationLease, ISOLATION_LEASE_DIR } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { ISOLATION_OWNER_FILE, decideIsolationReclaim } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, ensureIsolation, resolveSandboxIdentity } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock, setWorktreesDir } from "@oh-my-pi/pi-utils";

const SCRATCH = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r8__t2/shared";
const cleanups: string[] = [];
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const d of cleanups.splice(0)) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}
async function makeRepo(): Promise<string> {
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
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

it("P1: clear and materialisation lock different names when the worktree root is a symlink", async () => {
	const real = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-wt-real-"));
	const linkParent = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-wt-link-"));
	cleanups.push(real, linkParent);
	const alias = path.join(linkParent, "wt");
	await fsp.symlink(real, alias);
	vi.spyOn(console, "log").mockImplementation(() => {});
	for (const root of [real, alias]) {
		setWorktreesDir(root);
		const name = `tprobe${root === real ? "r" : "a"}01`;
		const dir = path.join(real, name);
		await fsp.mkdir(path.join(dir, "m"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "x\n");
		await Bun.write(path.join(dir, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: name }));
		// Exactly the lock ensureIsolation / cleanupIsolation hold for this sandbox.
		const lock = await acquireFileLock(await resolveSandboxIdentity(path.join(root, name)));
		const t0 = performance.now();
		const result = await clearWorktrees({ all: false, json: false, dryRun: false } as never).catch(e => String(e));
		const ms = Math.round(performance.now() - t0);
		lock.release();
		console.error(`root=${root === real ? "real" : "symlink"} heldLock=${await resolveSandboxIdentity(path.join(root, name))} clear=${JSON.stringify(result)} ms=${ms} dirStillExists=${await fsp.stat(dir).then(() => true, () => false)}`);
	}
}, 20_000);

it("P2: a lease the owner did not register strands the deferred teardown", async () => {
	rcopy();
	const repo = await makeRepo();
	const wtReal = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-wt2-"));
	cleanups.push(wtReal);
	setWorktreesDir(wtReal);

	// (a) lease from another process
	{
		const handle = await ensureIsolation(repo, "xproc");
		const data = path.join(handle.mergedDir, "work.txt");
		await Bun.write(data, "uncaptured\n");
		const script = path.join(SCRATCH, "lease-child.ts");
		const child = Bun.spawn(["bun", script, handle.mergedDir], {
			cwd: "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent",
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		const reader = child.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		console.error("child said:", first.trim());
		await cleanupIsolation(handle);
		console.error("(a) after owner teardown, data exists:", await Bun.file(data).exists());
		child.stdin.write("go\n");
		child.stdin.end();
		await child.exited;
		await scheduler.wait(1500);
		console.error(
			"(a) child released lease + exited; live lease:",
			await hasLiveIsolationLease(path.dirname(handle.mergedDir)),
			"data still exists 1.5s later:",
			await Bun.file(data).exists(),
		);
	}
	// (b) same process, lease via an alias path of the worktree root
	{
		const linkParent = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-wt2-link-"));
		cleanups.push(linkParent);
		const alias = path.join(linkParent, "wt");
		await fsp.symlink(wtReal, alias);
		const handle = await ensureIsolation(repo, "alias");
		const data = path.join(handle.mergedDir, "work.txt");
		await Bun.write(data, "uncaptured\n");
		const aliasCwd = path.join(alias, path.relative(wtReal, handle.mergedDir));
		const release = await leaseIsolationWorkspace(aliasCwd);
		await cleanupIsolation(handle);
		console.error("(b) after owner teardown, data exists:", await Bun.file(data).exists());
		await release();
		await scheduler.wait(500);
		console.error(
			"(b) lease released; live lease:",
			await hasLiveIsolationLease(path.dirname(handle.mergedDir)),
			"data still exists:",
			await Bun.file(data).exists(),
		);
	}
}, 30_000);

it("P3: a lease taken after the teardown's lease check is deleted from under its holder", async () => {
	rcopy();
	const repo = await makeRepo();
	const wtReal = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-wt3-"));
	cleanups.push(wtReal);
	setWorktreesDir(wtReal);
	const handle = await ensureIsolation(repo, "race");
	const nested = path.join(handle.mergedDir, "nested");
	await fsp.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	let leaseTaken = false;
	const realRename = fsp.rename;
	const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
		if (!leaseTaken && String(from) === path.dirname(handle.mergedDir)) {
			leaseTaken = true;
			// A descendant starts here, after hasLiveIsolationLease() said "none".
			await leaseIsolationWorkspace(nested);
			await Bun.write(data, "written by a descendant\n");
			console.error("P3 lease written at rename time; live lease:", await hasLiveIsolationLease(path.dirname(handle.mergedDir)));
		}
		return realRename(from as string, to as string);
	});
	await cleanupIsolation(handle);
	console.error("P3 rename intercepted:", spy.mock.calls.length > 0, "descendant data exists after teardown:", await Bun.file(data).exists(), "nested cwd exists:", await fsp.stat(nested).then(() => true, () => false));
}, 30_000);

it("P4: an unlistable lease dir reads as no lease", async () => {
	const base = await fsp.mkdtemp(path.join(os.tmpdir(), "probe-p4-"));
	cleanups.push(base);
	await fsp.mkdir(path.join(base, "m"), { recursive: true });
	await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "x", generation: "g" }));
	const release = await leaseIsolationWorkspace(path.join(base, "m")); // live lease held by this process
	console.error("P4 live lease before chmod:", await hasLiveIsolationLease(base));
	await fsp.chmod(path.join(base, ISOLATION_LEASE_DIR), 0o000);
	console.error("P4 after chmod 000 -> hasLive:", await hasLiveIsolationLease(base), "decision:", JSON.stringify(await decideIsolationReclaim(base)));
	await fsp.chmod(path.join(base, ISOLATION_LEASE_DIR), 0o755);
	await release();
});
