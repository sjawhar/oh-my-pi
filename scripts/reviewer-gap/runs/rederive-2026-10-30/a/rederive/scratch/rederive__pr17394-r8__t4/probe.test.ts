import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { ISOLATION_LEASE_DIR, leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock, setWorktreesDir, tryAcquireFileLock } from "@oh-my-pi/pi-utils";

const SCRATCH = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/a/rederive/scratch/rederive__pr17394-r8__t4/tmp";
const cleanup: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}
async function repo(): Promise<string> {
	await fs.mkdir(SCRATCH, { recursive: true });
	const r = await fs.mkdtemp(path.join(SCRATCH, "repo-"));
	cleanup.push(r);
	await git(r, ["init", "-q", "-b", "main"]);
	await git(r, ["config", "user.email", "a@b"]);
	await git(r, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["commit", "-q", "-m", "c"]);
	return r;
}
function rcopy() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}
async function wtBase(alias = false): Promise<string> {
	const real = await fs.mkdtemp(path.join(SCRATCH, "wt-"));
	cleanup.push(real);
	if (!alias) {
		setWorktreesDir(real);
		return real;
	}
	const link = `${real}-alias`;
	await fs.symlink(real, link);
	cleanup.push(link);
	setWorktreesDir(link);
	return link;
}
async function exists(p: string): Promise<boolean> {
	return await fs.stat(p).then(() => true, () => false);
}

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	for (const d of cleanup.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("probes", () => {
	it("P1: old generation's teardown forgets the successor's lease record -> successor leaks", async () => {
		delete process.env.OMP_WORKTREE_DIR;
		const r = await repo();
		await wtBase();
		rcopy();
		const a = await ensureIsolation(r, "same-id");
		const baseDir = path.dirname(a.mergedDir);

		// Hold A's backend stop (the retired copy's slow teardown) so B can claim meanwhile.
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const realStop = natives.isoStop;
		let held = false;
		vi.spyOn(natives, "isoStop").mockImplementation(async (kind, dir) => {
			if (!held && dir.includes(".retiring-")) {
				held = true;
				entered.resolve();
				await gate.promise;
			}
			return await realStop(kind, dir);
		});
		const aTeardown = cleanupIsolation(a);
		await entered.promise;

		const b = await ensureIsolation(r, "same-id"); // replacement spawn, same id
		gate.resolve();
		await aTeardown; // A finishes: forgetIsolationWorkspace(mergedDir) == B's key

		const nested = path.join(b.mergedDir, "nested");
		await fs.mkdir(nested, { recursive: true });
		const child = await leaseIsolationWorkspace(nested);
		await cleanupIsolation(b); // deferred: a lease is live
		await child(); // last user leaves: the deferred teardown should run now
		await Bun.sleep(100);

		const leftover = await exists(b.mergedDir);
		const marker = await Bun.file(path.join(baseDir, ".omp-isolation-owner.json")).text().catch(() => "<none>");
		console.log("P1 B mergedDir still exists after last lease released:", leftover, "marker:", marker);
		expect(leftover).toBe(false);
	});

	it("P2: lease taken after teardown's lease check but before rename -> teardown deletes a leased sandbox", async () => {
		delete process.env.OMP_WORKTREE_DIR;
		const r = await repo();
		await wtBase();
		rcopy();
		const h = await ensureIsolation(r, "lease-race");
		const baseDir = path.dirname(h.mergedDir);
		const nested = path.join(h.mergedDir, "nested");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(path.join(nested, "work.txt"), "child's work\n");

		const realRename = fs.rename;
		let release: (() => Promise<void>) | undefined;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(from) === baseDir && !release) {
				// A nested child spawns now (another task, no lock needed for a lease).
				release = await leaseIsolationWorkspace(nested);
				console.log("P2 lease files at rename time:", await fs.readdir(path.join(baseDir, ISOLATION_LEASE_DIR)));
			}
			return await realRename(from, to);
		});
		await cleanupIsolation(h);
		const survived = await exists(path.join(nested, "work.txt"));
		console.log("P2 lease returned:", typeof release, "child's work survived teardown:", survived);
		await release?.();
		expect(survived).toBe(true);
	});

	it("P3: omp worktree clear locks the alias path; ensureIsolation locks realpath -> no exclusion", async () => {
		delete process.env.OMP_WORKTREE_DIR;
		const r = await repo();
		const root = await wtBase(true);
		rcopy();
		// A crashed run's leftover: marker names a dead process.
		const crashed = await ensureIsolation(r, "clear-race");
		const realBase = path.dirname(crashed.mergedDir);
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		await Bun.write(path.join(realBase, ".omp-isolation-owner.json"), JSON.stringify({ pid: dead.pid, id: "clear-race", generation: "dead-1" }));
		const rel = path.relative(await fs.realpath(root), realBase);
		const aliasBase = path.join(root, rel);
		console.log("P3 CLI path:", aliasBase, "| ensureIsolation lock path:", realBase);

		const aliasLock = await acquireFileLock(aliasBase);
		const realLock = tryAcquireFileLock(realBase);
		console.log("P3 realpath lock acquirable while alias lock held:", realLock !== null);
		realLock?.release();
		aliasLock.release();

		const realRm = fs.rm;
		let fresh: Awaited<ReturnType<typeof ensureIsolation>> | undefined;
		vi.spyOn(fs, "rm").mockImplementation(async (target, opts) => {
			if (String(target) === aliasBase && !fresh) {
				// CLI has decided under "the sandbox's own lock"; a new run of this id materialises now.
				const t0 = Date.now();
				fresh = await ensureIsolation(r, "clear-race");
				console.log(`P3 ensureIsolation completed inside CLI's locked window in ${Date.now() - t0}ms, generation ${fresh.generation}`);
				await fs.writeFile(path.join(fresh.mergedDir, "live.txt"), "new run's data\n");
			}
			return await realRm(target, opts);
		});
		const result = await clearWorktrees({ json: true } as never);
		const survived = fresh ? await exists(path.join(fresh.mergedDir, "live.txt")) : "n/a";
		console.log("P3 clear result:", JSON.stringify(result), "fresh sandbox survived:", survived);
		expect(survived).toBe(true);
	});

	it("P4: lease held by another process -> owner's deferred teardown never runs after it leaves", async () => {
		delete process.env.OMP_WORKTREE_DIR;
		const r = await repo();
		await wtBase();
		rcopy();
		const h = await ensureIsolation(r, "foreign-lease");
		const baseDir = path.dirname(h.mergedDir);
		const other = Bun.spawn(["sleep", "30"]);
		await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, "other.json"), JSON.stringify({ pid: other.pid }));
		await cleanupIsolation(h); // deferred
		console.log("P4 after cleanup, sandbox exists:", await exists(h.mergedDir));
		// The other process's session ends: it removes its lease file (what its release does) and exits.
		await fs.rm(path.join(baseDir, ISOLATION_LEASE_DIR, "other.json"));
		other.kill();
		await other.exited;
		await Bun.sleep(500);
		console.log("P4 500ms after the only lease ended, sandbox exists:", await exists(h.mergedDir));
		expect(await exists(h.mergedDir)).toBe(false);
	});
});
