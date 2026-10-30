import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/utils/src/index.ts";
import { clearWorktrees } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/cli/worktree-cli.ts";
import { ISOLATION_OWNER_FILE } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership.ts";
import { resolveSandboxIdentity } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/worktree.ts";

async function run(useSymlink: boolean) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	const real = path.join(root, "real");
	const link = path.join(root, "link");
	await fs.mkdir(real);
	await fs.symlink(real, link);
	process.env.OMP_WORKTREE_DIR = useSymlink ? link : real;
	const sandbox = path.join(useSymlink ? link : real, "tabc");
	await fs.mkdir(path.join(sandbox, "m"), { recursive: true });
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	// A crashed run's leftover: marker names a dead pid, so the scan says reclaimable.
	await Bun.write(path.join(sandbox, ISOLATION_OWNER_FILE), JSON.stringify({ pid: dead.pid, id: "x", generation: "g0" }));
	// ensureIsolation for the same id is mid-materialisation: it holds the lock on the resolved identity.
	const identity = await resolveSandboxIdentity(sandbox);
	const held = await acquireFileLock(identity);
	const start = Date.now();
	const origLog = console.log;
	let out = "";
	console.log = (...a: unknown[]) => void (out += a.join(" "));
	let result: unknown;
	try {
		result = await clearWorktrees({ all: false, dryRun: false, json: true });
	} catch (e) {
		result = String(e);
	} finally {
		console.log = origLog;
		held.release();
	}
	const exists = await fs.exists(path.join(real, "tabc"));
	console.log(
		`symlink=${useSymlink} lockHeldOn=${identity} clearUsed=${sandbox} elapsedMs=${Date.now() - start} result=${JSON.stringify(result)} sandboxStillExists=${exists}`,
	);
	await fs.rm(root, { recursive: true, force: true });
}

it("clear honours the materialisation lock only when the worktree dir has no symlink", async () => {
	await run(false);
	await run(true);
}, 20_000);
