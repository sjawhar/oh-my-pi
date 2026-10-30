import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease.ts";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree.ts";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, ...args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

async function repo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await git(dir, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(dir, "a.txt"), "a\n");
	await git(dir, "add", ".");
	await git(dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

function setup() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}

for (const staleCleanupInWindow of [false, true]) {
	it(`nested-child lease defers B's teardown (stale A cleanup in window: ${staleCleanupInWindow})`, async () => {
		setup();
		const wt = await repo();
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wtbase-"));
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
		const id = `reuse-${staleCleanupInWindow}`;

		let resumeA: (() => void) | undefined;
		if (staleCleanupInWindow) {
			const A = await ensureIsolation(wt, id);
			const realStop = natives.isoStop;
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			resumeA = gate.resolve;
			vi.spyOn(natives, "isoStop").mockImplementationOnce(async (k, m) => {
				entered.resolve();
				await gate.promise; // T1 passed: generation checked, dir renamed, lock released
				return await realStop(k, m);
			});
			const aDone = cleanupIsolation(A);
			await entered.promise;
			// Replacement spawn materialises the same id while A's teardown is in isoStop.
			var B = await ensureIsolation(wt, id);
			gate.resolve();
			await aDone; // A's finally: forgetIsolationWorkspace(mergedDir)  (T2)
		} else {
			var B = await ensureIsolation(wt, id);
		}
		void resumeA;

		const live = path.join(B!.mergedDir, "child-work.txt");
		await fs.writeFile(live, "nested child still working\n");
		// A nested child spawned from B's isolated child takes a lease on B's sandbox.
		const release = leaseIsolationWorkspace(path.join(B!.mergedDir));
		await cleanupIsolation(B!); // owner's teardown: must be deferred while the lease is held
		const survived = await Bun.file(live).exists();
		console.log(`staleCleanupInWindow=${staleCleanupInWindow} B workspace survived owner teardown while leased: ${survived}`);
		release();
		await Bun.sleep(200);
		expect(survived).toBe(true);
	});
}
