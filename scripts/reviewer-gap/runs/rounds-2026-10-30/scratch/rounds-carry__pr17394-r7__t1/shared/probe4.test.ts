import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import { hasLiveIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-ownership";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir, tryAcquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
let wt = "";
async function setup() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	wt = await fs.mkdtemp(path.join(os.tmpdir(), "probe4-wt-"));
	setWorktreesDir(wt);
	delete process.env.OMP_WORKTREE_DIR;
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "probe4-repo-"));
	await git(r, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"]);
	return r;
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("rm failure in the un-retired branch leaks the sandbox lock", async () => {
	const r = await setup();
	const a = await ensureIsolation(r, "rmfail-id");
	const baseDir = path.dirname(a.mergedDir);
	// Rename refused (as for a pinned mount: EBUSY), so teardown keeps the lock.
	vi.spyOn(fs, "rename").mockImplementation(async () => {
		throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
	});
	// A read-only subtree the non-root rm cannot empty -> EACCES.
	const ro = path.join(a.mergedDir, "ro");
	await fs.mkdir(ro);
	await fs.writeFile(path.join(ro, "x"), "x");
	await fs.chmod(ro, 0o555);
	const res = await cleanupIsolation(a).then(() => "resolved", e => `rejected: ${e}`);
	console.log("cleanup:", res);
	await fs.chmod(ro, 0o755);
	vi.restoreAllMocks();
	console.log("lock free afterwards:", tryAcquireFileLock(baseDir) !== null);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	const t0 = Date.now();
	const b = await ensureIsolation(r, "rmfail-id").then(h => `ok ${h.generation}`, e => String(e));
	console.log("next ensureIsolation same id:", b, `${Date.now() - t0} ms`);
}, 20000);

it("non-unavailable isoStart failure leaves a live-owned shell", async () => {
	const r = await setup();
	vi.spyOn(natives, "isoStart").mockRejectedValue(new Error("boom: clone failed"));
	const res = await ensureIsolation(r, "fail-id").then(() => "ok", e => String(e));
	console.log("ensure:", res);
	console.log("wt root entries:", await fs.readdir(wt));
	for (const e of await fs.readdir(wt)) {
		const p = path.join(wt, e);
		if ((await fs.stat(p)).isDirectory()) {
			console.log(e, "contents:", await fs.readdir(p), "live owner:", await hasLiveIsolationOwner(p));
		}
	}
});

it("clean lifecycle leaves .lock files in the worktree root", async () => {
	const r = await setup();
	for (const id of ["a1", "a2", "a3"]) {
		const h = await ensureIsolation(r, id);
		await cleanupIsolation(h);
	}
	console.log("wt root after 3 full lifecycles:", await fs.readdir(wt));
});
