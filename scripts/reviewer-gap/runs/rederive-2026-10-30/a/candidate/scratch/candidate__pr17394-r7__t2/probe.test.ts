import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir, tryAcquireFileLock } from "@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}
async function repo(): Promise<string> {
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await git(r, ["init", "-q"]);
	await git(r, ["config", "user.email", "t@t"]);
	await git(r, ["config", "user.name", "t"]);
	await fs.writeFile(path.join(r, "a.txt"), "a\n");
	await git(r, ["add", "."]);
	await git(r, ["commit", "-qm", "init"]);
	return r;
}
async function useWt() {
	const wt = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wt);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: null,
	} as never);
	return wt;
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("T1: failed in-place teardown leaks the sandbox lock", async () => {
	await useWt();
	const r = await repo();
	const h = await ensureIsolation(r, "leak");
	const baseDir = path.dirname(h.mergedDir);
	const realRm = fs.rm;
	vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }));
	vi.spyOn(fs, "rm").mockImplementation((async (p: string, o: unknown) => {
		if (p === baseDir) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		return realRm(p, o as never);
	}) as never);
	const err = await cleanupIsolation(h).then(() => "resolved", e => String(e));
	console.log("cleanupIsolation ->", err);
	vi.restoreAllMocks();
	await useWtSpyOnly();
	const probe = tryAcquireFileLock(baseDir);
	console.log("lock free after failed cleanup?", probe !== null);
	probe?.release();
	const t0 = performance.now();
	const next = await ensureIsolation(r, "leak").then(
		x => `ok ${x.generation}`,
		e => `rejected: ${String(e)}`,
	);
	console.log("next ensureIsolation(same id) ->", next, `after ${Math.round(performance.now() - t0)}ms`);
}, 30_000);

async function useWtSpyOnly() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: null,
	} as never);
}

it("T2: a materialisation slower than 5s makes a concurrent same-id spawn fail", async () => {
	await useWt();
	const r = await repo();
	const realStart = natives.isoStart;
	let n = 0;
	vi.spyOn(natives, "isoStart").mockImplementation((async (...a: Parameters<typeof realStart>) => {
		if (n++ === 0) await Bun.sleep(6000); // a large clone
		return realStart(...a);
	}) as never);
	const t0 = performance.now();
	const first = ensureIsolation(r, "slow").then(
		x => `ok`,
		e => `rejected: ${String(e)}`,
	);
	await Bun.sleep(200);
	const second = ensureIsolation(r, "slow").then(
		x => `ok`,
		e => `rejected: ${String(e)}`,
	);
	console.log("second ->", await second, `after ${Math.round(performance.now() - t0)}ms`);
	console.log("first ->", await first);
}, 30_000);

it("T3: a descendant leasing a symlinked alias of the sandbox is not counted", async () => {
	const wt = await useWt();
	const r = await repo();
	const h = await ensureIsolation(r, "alias");
	const alias = path.join(os.tmpdir(), `probe-alias-${process.pid}`);
	await fs.rm(alias, { force: true });
	await fs.symlink(wt, alias);
	const aliasCwd = path.join(alias, path.relative(wt, h.mergedDir));
	console.log("alias realpath === mergedDir?", (await fs.realpath(aliasCwd)) === (await fs.realpath(h.mergedDir)));
	const release = leaseIsolationWorkspace(aliasCwd);
	await fs.writeFile(path.join(h.mergedDir, "descendant.txt"), "work\n");
	await cleanupIsolation(h);
	console.log("descendant work survives owner teardown?", await Bun.file(path.join(h.mergedDir, "descendant.txt")).exists());
	release();
	await fs.rm(alias, { force: true });
}, 30_000);
