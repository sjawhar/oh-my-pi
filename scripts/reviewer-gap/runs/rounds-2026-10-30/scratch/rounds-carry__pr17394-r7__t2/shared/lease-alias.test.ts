import { test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const scratch = fs.mkdtempSync("/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r7__t2/shared/la-");
fs.mkdirSync(path.join(scratch, "wt-real"));
fs.symlinkSync(path.join(scratch, "wt-real"), path.join(scratch, "wt"));
process.env.OMP_WORKTREE_DIR = path.join(scratch, "wt"); // worktree base reached through a symlink

const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task";
const { ensureIsolation, cleanupIsolation } = await import(`${H}/worktree.ts`);
const { leaseIsolationWorkspace } = await import(`${H}/isolation-lease.ts`);

test("lease taken on the canonical spelling of the sandbox cwd", async () => {
	const repo = path.join(scratch, "repo");
	fs.mkdirSync(repo);
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
	Bun.spawnSync(["git", "add", "."], { cwd: repo });
	Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: repo });
	const h = await ensureIsolation(repo, "alias");
	const canonical = fs.realpathSync(h.mergedDir);
	console.log("mergedDir", h.mergedDir, "\ncanonical", canonical);
	const release = leaseIsolationWorkspace(canonical);
	await cleanupIsolation(h);
	console.log("merged exists while nested child (canonical cwd) holds lease =", fs.existsSync(canonical));
	release();
});
