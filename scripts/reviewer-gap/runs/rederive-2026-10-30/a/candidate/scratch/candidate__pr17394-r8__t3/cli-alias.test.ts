import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { resolveSandboxIdentity } from "@oh-my-pi/pi-coding-agent/task/worktree";

it("clear deletes a sandbox whose lock a materialisation holds, when the worktree dir is a symlink", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alias-")));
	const real = path.join(root, "real-wt");
	const link = path.join(root, "link-wt");
	await fs.mkdir(real);
	await fs.symlink(real, link);
	process.env.OMP_WORKTREE_DIR = link; // e.g. ~/.omp is a symlink to a data disk

	const sandbox = path.join(link, "tdeadbeef1");
	await fs.mkdir(path.join(sandbox, "m"), { recursive: true });
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	// a crashed earlier run of this id
	await Bun.write(path.join(sandbox, ".omp-isolation-owner.json"), JSON.stringify({ pid: dead.pid, id: "x", generation: "old" }));

	// ensureIsolation for a replacement spawn of the same id: takes the lock on the canonical path
	const identity = await resolveSandboxIdentity(sandbox);
	const held = await acquireFileLock(identity);
	console.log("materialisation holds lock on", identity + ".lock");

	const t0 = Date.now();
	const res = await clearWorktrees({ json: true } as any);
	console.log("clear returned after", Date.now() - t0, "ms:", JSON.stringify(res));
	console.log("sandbox exists while its lock is held:", await fs.exists(path.join(real, "tdeadbeef1")));
	held.release();
	delete process.env.OMP_WORKTREE_DIR;
	await fs.rm(root, { recursive: true, force: true });
}, 60000);
