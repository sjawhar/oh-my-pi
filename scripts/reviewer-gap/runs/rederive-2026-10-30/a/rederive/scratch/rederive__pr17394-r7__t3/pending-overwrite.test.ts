import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";
import { $ } from "bun";

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

async function setup(tag: string) {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-repo-`));
	await $`git init -q && git config user.email a@b && git config user.name a && echo hi > f.txt && git add . && git commit -qm init`
		.cwd(repo)
		.quiet();
	const wtBase = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-wt-`));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtBase);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	return repo;
}

it("a stale handle's late teardown replaces the live generation's deferred teardown", async () => {
	const repo = await setup("pending");
	const id = "same-id";
	const a = await ensureIsolation(repo, id); // stale handle (g1), its teardown arrives late
	const b = await ensureIsolation(repo, id); // current owner (g2), same path
	const baseDir = path.dirname(b.mergedDir);
	const nested = path.join(b.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const release = leaseIsolationWorkspace(nested); // B's descendant

	await cleanupIsolation(b); // B's owner ends: deferred behind the lease
	await cleanupIsolation(a); // late release of the stale handle
	release(); // descendant ends: the deferred teardown should now remove B's sandbox
	await Bun.sleep(300);

	const left = await fs.readdir(baseDir).catch(() => null);
	console.log("sandbox after last lease ended:", left);
	expect(left).toBeNull();
});

it("control: same calls, stale teardown first", async () => {
	const repo = await setup("pending-ctl");
	const id = "same-id";
	const a = await ensureIsolation(repo, id);
	const b = await ensureIsolation(repo, id);
	const baseDir = path.dirname(b.mergedDir);
	const nested = path.join(b.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(a);
	await cleanupIsolation(b);
	release();
	await Bun.sleep(300);
	const left = await fs.readdir(baseDir).catch(() => null);
	console.log("control sandbox after last lease ended:", left);
	expect(left).toBeNull();
});
