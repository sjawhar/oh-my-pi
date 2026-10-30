import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/cli/worktree-cli";
import { ISOLATION_OWNER_FILE } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";
import { resolveSandboxIdentity } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/worktree";
import { acquireFileLock, getWorktreesDir, setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/utils/src/index";

const roots: string[] = [];
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
	const proc = Bun.spawn(["true"]);
	await proc.exited;
	return proc.pid;
}

async function scenario(useAlias: boolean) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-alias-"));
	roots.push(root);
	const real = path.join(root, "real-wt");
	const link = path.join(root, "link-wt");
	await fs.mkdir(real);
	await fs.symlink(real, link);
	const wt = useAlias ? link : real;
	process.env.OMP_WORKTREE_DIR = wt;
	const sandbox = path.join(wt, "tdead0002");
	await fs.mkdir(path.join(sandbox, "m"), { recursive: true });
	await Bun.write(path.join(sandbox, "m", "work.txt"), "x\n");
	await Bun.write(path.join(sandbox, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "dead0002" }));
	// What ensureIsolation / cleanupIsolation lock: the realpath identity.
	const identity = await resolveSandboxIdentity(sandbox);
	const held = await acquireFileLock(identity);
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
	const t0 = performance.now();
	const res = await clearWorktrees({ all: false, dryRun: false, json: true });
	const ms = Math.round(performance.now() - t0);
	vi.restoreAllMocks();
	held.release();
	const stillThere = await fs.stat(sandbox).then(() => true, () => false);
	console.error(
		`alias=${useAlias} wtDir=${getWorktreesDir()} lockedIdentity=${identity} clear=${JSON.stringify(res)} ms=${ms} sandboxExists=${stillThere}`,
	);
}

it("clear vs materialisation lock: real path", async () => {
	await scenario(false);
}, 30000);

it("clear vs materialisation lock: symlinked worktrees dir", async () => {
	await scenario(true);
}, 30000);
