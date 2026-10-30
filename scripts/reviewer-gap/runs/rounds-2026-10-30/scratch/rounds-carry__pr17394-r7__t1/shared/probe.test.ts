import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock, setWorktreesDir } from "@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}
async function repo(): Promise<string> {
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await git(r, ["init", "-q", "-b", "main"]);
	await git(r, ["config", "user.email", "a@b"]);
	await git(r, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["commit", "-q", "-m", "base"]);
	return r;
}
async function setup() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(base);
	return { r: await repo(), base };
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("stale teardown's forget drops a successor's lease registration", async () => {
	const { r } = await setup();
	const a = await ensureIsolation(r, "same-id");
	// Pause A's teardown after it retired the dir and released the lock.
	const gate = Promise.withResolvers<void>();
	const realStop = natives.isoStop;
	let stops = 0;
	vi.spyOn(natives, "isoStop").mockImplementation(async (...args) => {
		if (stops++ === 0) await gate.promise;
		return await realStop(...args);
	});
	const aDone = cleanupIsolation(a);
	await scheduler.wait(100);
	const b = await ensureIsolation(r, "same-id"); // replacement spawn
	const nested = path.join(b.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "descendant work\n");
	gate.resolve();
	await aDone;
	const release = leaseIsolationWorkspace(nested); // nested child of B starts
	await cleanupIsolation(b); // B's owner ends; should defer while leased
	console.log("descendant data after B cleanup while leased:", await Bun.file(data).exists());
	release();
});

it("lease taken before A's forget is also lost", async () => {
	const { r } = await setup();
	const a = await ensureIsolation(r, "same-id2");
	const gate = Promise.withResolvers<void>();
	const realStop = natives.isoStop;
	let stops = 0;
	vi.spyOn(natives, "isoStop").mockImplementation(async (...args) => {
		if (stops++ === 0) await gate.promise;
		return await realStop(...args);
	});
	const aDone = cleanupIsolation(a);
	await scheduler.wait(100);
	const b = await ensureIsolation(r, "same-id2");
	const nested = path.join(b.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "descendant work\n");
	const release = leaseIsolationWorkspace(nested);
	gate.resolve();
	await aDone;
	await cleanupIsolation(b);
	console.log("descendant (leased before A forget) data after B cleanup:", await Bun.file(data).exists());
	release();
});

it("teardown during a >5s materialisation throws and leaks", async () => {
	const { r } = await setup();
	const stale = await ensureIsolation(r, "slow-id");
	const realStart = natives.isoStart;
	vi.spyOn(natives, "isoStart").mockImplementation(async (...args) => {
		await scheduler.wait(6000); // large clone
		return await realStart(...args);
	});
	const successor = ensureIsolation(r, "slow-id");
	await scheduler.wait(100);
	const t0 = Date.now();
	const err = await cleanupIsolation(stale).then(
		() => "resolved",
		e => String(e),
	);
	console.log("stale cleanup during slow materialise:", err, "after", Date.now() - t0, "ms");
	const t1 = Date.now();
	const second = await ensureIsolation(r, "slow-id").then(
		h => `ok ${h.generation}`,
		e => String(e),
	);
	console.log("concurrent ensureIsolation same id:", second, "after", Date.now() - t1, "ms");
	await successor;
}, 30000);

it("cleanup when the lock is held elsewhere", async () => {
	const { r } = await setup();
	const h = await ensureIsolation(r, "held-id");
	const lock = await acquireFileLock(path.dirname(h.mergedDir));
	const t0 = Date.now();
	const res = await cleanupIsolation(h).then(
		() => "resolved",
		e => String(e),
	);
	lock.release();
	console.log("cleanup with lock held:", res, Date.now() - t0, "ms; dir exists:", await Bun.file(path.join(h.mergedDir, "f.txt")).exists());
}, 30000);
