import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
	deferTeardownWhileLeased,
	leaseIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import * as natives from "@oh-my-pi/pi-natives";
import { acquireFileLock, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

async function repo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await $`git init -q -b main && git config user.email a@b && git config user.name a && echo hi > a.txt && git add . && git commit -qm init`.cwd(dir).quiet();
	return dir;
}

function rcopy() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

describe("probe", () => {
	it("in-flight teardown of gen A forgets gen B's lease registration", async () => {
		rcopy();
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-")));
		const wt = await repo();
		const a = await ensureIsolation(wt, "same-id");
		// Make A's teardown slow: lots of files under its merged dir.
		await $`mkdir -p big && cd big && seq 1 40000 | xargs touch`.cwd(a.mergedDir).quiet();
		const t0 = performance.now();
		const tearA = cleanupIsolation(a);
		// Wait until A has renamed (retired) the directory and released the lock.
		const baseDir = path.dirname(a.mergedDir);
		while (await fs.stat(baseDir).then(() => true, () => false)) await Bun.sleep(1);
		const b = await ensureIsolation(wt, "same-id");
		const bReadyAt = performance.now() - t0;
		await tearA;
		const aDoneAt = performance.now() - t0;
		console.log(JSON.stringify({ bReadyAt: Math.round(bReadyAt), aDoneAt: Math.round(aDoneAt), sameMerged: a.mergedDir === b.mergedDir }));
		// A nested descendant now starts working inside B's sandbox.
		const nested = path.join(b.mergedDir, "sub");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(path.join(nested, "work.txt"), "descendant work\n");
		const release = leaseIsolationWorkspace(nested);
		const deferred = deferTeardownWhileLeased(b.mergedDir, async () => {});
		console.log(JSON.stringify({ deferredWhileDescendantHoldsLease: deferred }));
		await cleanupIsolation(b);
		console.log(JSON.stringify({ descendantFileAfterOwnerTeardown: await Bun.file(path.join(nested, "work.txt")).exists() }));
		release();
	}, 60_000);

	it("teardown and materialisation throw when the sandbox lock is held past 5s", async () => {
		rcopy();
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-")));
		const wt = await repo();
		const a = await ensureIsolation(wt, "lock-id");
		const lock = await acquireFileLock(path.dirname(a.mergedDir));
		const t0 = performance.now();
		const r1 = await cleanupIsolation(a).then(() => "resolved", e => `rejected: ${(e as Error).message}`);
		console.log(JSON.stringify({ cleanup: r1, ms: Math.round(performance.now() - t0) }));
		const r2 = await ensureIsolation(wt, "lock-id").then(() => "resolved", e => `rejected: ${(e as Error).message}`);
		console.log(JSON.stringify({ ensure: r2 }));
		lock.release();
	}, 60_000);

	it("a failed materialisation leaves a marker naming this live process", async () => {
		rcopy();
		delete process.env.OMP_WORKTREE_DIR;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
		setWorktreesDir(root);
		const wt = await repo();
		vi.spyOn(natives, "isoStart").mockRejectedValue(new Error("EIO: disk failure during clone"));
		const r = await ensureIsolation(wt, "fail-id").then(() => "resolved", e => `rejected: ${(e as Error).message}`);
		const entries = await fs.readdir(root);
		const base = path.join(root, entries[0]!);
		console.log(JSON.stringify({ ensure: r, leftover: entries, contents: await fs.readdir(base), live: await hasLiveIsolationOwner(base), marker: await Bun.file(path.join(base, ISOLATION_OWNER_FILE)).text() }));
	}, 60_000);
});
