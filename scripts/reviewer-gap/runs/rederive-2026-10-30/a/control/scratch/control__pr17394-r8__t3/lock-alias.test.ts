import { test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/utils/src/index";
import { resolveSandboxIdentity } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/worktree";

// ensureIsolation locks resolveSandboxIdentity(baseDir); clearWorktrees locks the raw scan path.
test("CLI lock vs materialisation lock through a symlinked worktree root", async () => {
	const real = await fs.mkdtemp(path.join(os.tmpdir(), "wt-real-"));
	const link = path.join(os.tmpdir(), `wt-link-${process.pid}`);
	await fs.rm(link, { force: true });
	await fs.symlink(real, link);
	await fs.mkdir(path.join(real, "tabc"));
	const scanPath = path.join(link, "tabc"); // what scanWorktrees yields
	const materialiseLock = await acquireFileLock(await resolveSandboxIdentity(scanPath), { retries: 1 });
	let cliAcquired = false;
	try {
		const cli = await acquireFileLock(scanPath, { retries: 1 });
		cliAcquired = true;
		cli.release();
	} catch {}
	materialiseLock.release();
	console.log({ scanPath, identity: await resolveSandboxIdentity(scanPath), cliAcquiredWhileMaterialiseHeld: cliAcquired });
	await fs.rm(link, { force: true });
	await fs.rm(real, { recursive: true, force: true });
});
