import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const ROOT = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages";
const utils = await import(`${ROOT}/utils/src/index.ts`);
const cli = await import(`${ROOT}/coding-agent/src/cli/worktree-cli.ts`);
const own = await import(`${ROOT}/coding-agent/src/task/isolation-ownership.ts`);
const wt = await import(`${ROOT}/coding-agent/src/task/worktree.ts`);

async function scenario(useAlias: boolean) {
	const top = await fs.mkdtemp(path.join(os.tmpdir(), "alias-probe-"));
	const real = path.join(top, "real");
	await fs.mkdir(real);
	const alias = path.join(top, "alias");
	await fs.symlink(real, alias);
	process.env.OMP_WORKTREE_DIR = useAlias ? alias : real;
	const viaCli = path.join(utils.getWorktreesDir(), "tabc123456");
	await fs.mkdir(path.join(viaCli, "m"), { recursive: true });
	await fs.writeFile(path.join(viaCli, "m", "work.txt"), "data");
	await own.markIsolationRetired(viaCli); // reclaimable per decideIsolationReclaim
	// What ensureIsolation / cleanupIsolation lock on:
	const identity = await wt.resolveSandboxIdentity(viaCli);
	const held = await utils.acquireFileLock(identity);
	const started = Date.now();
	let out: unknown;
	const log = console.log;
	const captured: string[] = [];
	console.log = (...a: unknown[]) => void captured.push(a.join(" "));
	try {
		out = await cli.clearWorktrees({ all: false, dryRun: false, json: true });
	} finally {
		console.log = log;
		held.release();
	}
	console.log(
		`alias=${useAlias} env=${process.env.OMP_WORKTREE_DIR} wtdir=${utils.getWorktreesDir()} cliPath=${viaCli} lockedIdentity=${identity} result=${JSON.stringify(out)} elapsedMs=${Date.now() - started} stillExists=${await fs.exists(identity)}\n${captured.join("\n")}`,
	);
	delete process.env.OMP_WORKTREE_DIR;
}

it("clear vs sandbox lock: canonical root", async () => scenario(false), 30_000);
it("clear vs sandbox lock: symlinked root", async () => scenario(true), 30_000);
