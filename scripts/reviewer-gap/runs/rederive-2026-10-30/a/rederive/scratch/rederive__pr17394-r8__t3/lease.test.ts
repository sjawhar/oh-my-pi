import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
	deferTeardownWhileLeased,
	hasLiveIsolationLease,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { ISOLATION_OWNER_FILE, writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock, setWorktreesDir, tryAcquireFileLock } from "@oh-my-pi/pi-utils";

const SCRATCH = path.dirname(import.meta.path);
const temps: string[] = [];
async function tmp(prefix: string) {
	const d = await fs.mkdtemp(path.join(SCRATCH, `tmp-${prefix}-`));
	temps.push(d);
	return d;
}
async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}
async function repo() {
	const r = await tmp("repo");
	await git(r, ["init", "-q", "-b", "main"]);
	await Bun.write(path.join(r, "a.txt"), "a\n");
	await git(r, ["add", "."]);
	await git(r, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"]);
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
afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	await Promise.all(temps.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

it("P1: lease released while teardown is deciding -> teardown deferred to nobody", async () => {
	const r = await repo();
	rcopy();
	setWorktreesDir(await tmp("wt"));
	const handle = await ensureIsolation(r, "p1");
	const base = path.dirname(handle.mergedDir);
	const nested = path.join(handle.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const descendant = await leaseIsolationWorkspace(nested);

	// Hold T1: cleanup's hasLiveIsolationLease has read the lease and is checking
	// the holder's liveness (/proc/<pid>/stat). The descendant ends right there.
	const origFile = Bun.file;
	let armed = true;
	let releasedInWindow = false;
	vi.spyOn(Bun, "file").mockImplementation(((p: unknown, o?: unknown) => {
		const f = (origFile as any)(p, o);
		if (armed && p === `/proc/${process.pid}/stat`) {
			armed = false;
			const text = f.text.bind(f);
			return Object.assign(Object.create(Object.getPrototypeOf(f)), f, {
				text: async () => {
					await descendant();
					releasedInWindow = true;
					return text();
				},
			});
		}
		return f;
	}) as never);

	await cleanupIsolation(handle);
	vi.restoreAllMocks();
	await scheduler.wait(200);
	console.log("P1 released in window:", releasedInWindow);
	console.log("P1 live lease after:", await hasLiveIsolationLease(base));
	console.log("P1 sandbox still on disk:", await Bun.file(path.join(base, ISOLATION_OWNER_FILE)).exists());
	console.log("P1 entries:", await fs.readdir(base));
});

it("P1b: natural race, no hooks", async () => {
	const r = await repo();
	rcopy();
	setWorktreesDir(await tmp("wt"));
	let leaked = 0;
	const N = 24;
	for (let i = 0; i < N; i++) {
		const handle = await ensureIsolation(r, `p1b-${i}`);
		const base = path.dirname(handle.mergedDir);
		const descendant = await leaseIsolationWorkspace(handle.mergedDir);
		const delay = i % 8; // ms
		await Promise.all([cleanupIsolation(handle), scheduler.wait(delay).then(() => descendant())]);
		await scheduler.wait(30);
		if (await fs.stat(base).catch(() => null)) leaked++;
	}
	console.log(`P1b leaked sandboxes: ${leaked}/${N}`);
}, 120_000);

it.only("P4: a replacement materialisation wipes a leased sandbox and its lease", async () => {
	const r = await repo();
	rcopy();
	setWorktreesDir(await tmp("wt"));
	const a = await ensureIsolation(r, "p4");
	const base = path.dirname(a.mergedDir);
	const data = path.join(a.mergedDir, "child.txt");
	const child = await leaseIsolationWorkspace(a.mergedDir);
	await fs.writeFile(data, "descendant work\n");
	console.log("P4 leased before:", await hasLiveIsolationLease(base));
	const b = await ensureIsolation(r, "p4");
	console.log("P4 descendant file survives:", await Bun.file(data).exists());
	console.log("P4 lease survives:", await hasLiveIsolationLease(base), "gen changed:", a.generation !== b.generation);
	await child();
}, 60_000);

it("P2: two leases released together run the pending teardown twice", async () => {
	const base = await tmp("p2");
	const merged = path.join(base, "m");
	await fs.mkdir(merged, { recursive: true });
	await writeIsolationOwner(base, "p2");
	registerIsolationWorkspace(merged);
	const a = await leaseIsolationWorkspace(merged);
	const b = await leaseIsolationWorkspace(merged);
	let runs = 0;
	const deferred = await deferTeardownWhileLeased(merged, async () => {
		runs++;
	});
	await Promise.all([a(), b()]);
	await scheduler.wait(50);
	console.log("P2 deferred:", deferred, "teardown runs:", runs);
});

it("P3: lease taken after the teardown retired the dir resurrects it, unowned", async () => {
	const r = await repo();
	rcopy();
	setWorktreesDir(await tmp("wt"));
	const handle = await ensureIsolation(r, "p3");
	const base = path.dirname(handle.mergedDir);
	const rename = fs.rename;
	let release: (() => Promise<void>) | undefined;
	vi.spyOn(fs, "rename").mockImplementation((async (from: string, to: string) => {
		await rename(from, to);
		if (from === base) {
			// A nested child starts in the sandbox cwd right after the teardown's
			// lease check — the lease writer takes no sandbox lock.
			release = await leaseIsolationWorkspace(path.join(handle.mergedDir, "sub"));
		}
	}) as never);
	await cleanupIsolation(handle);
	vi.restoreAllMocks();
	console.log("P3 base exists after teardown:", !!(await fs.stat(base).catch(() => null)));
	console.log("P3 base entries:", await fs.readdir(base).catch(e => String(e)));
	console.log("P3 merged (child cwd) exists:", !!(await fs.stat(handle.mergedDir).catch(() => null)));
	await release?.();
	console.log("P3 after child release, base entries:", await fs.readdir(base).catch(e => String(e)));
});

it("P5: CLI lock on unresolved path does not exclude ensureIsolation's realpath lock", async () => {
	const real = await tmp("real");
	const link = path.join(await tmp("lnk"), "wt");
	await fs.symlink(real, link);
	const seg = "t123";
	const held = await acquireFileLock(path.join(real, seg)); // ensureIsolation's name (realpath)
	const cli = tryAcquireFileLock(path.join(link, seg)); // clearWorktrees' name (scan of getWorktreesDir())
	console.log("P5 CLI got lock while materialisation holds it:", cli !== null);
	cli?.release();
	held.release();
});
