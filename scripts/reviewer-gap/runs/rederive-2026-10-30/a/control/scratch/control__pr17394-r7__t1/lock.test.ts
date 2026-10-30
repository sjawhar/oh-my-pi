import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/utils/src/file-lock";
import { cleanupIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-ownership";

test("cleanupIsolation gives up after 5s while a materialisation holds the sandbox lock", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "iso-lock-"));
	const baseDir = path.join(root, "task-x");
	await fs.mkdir(path.join(baseDir, "m"), { recursive: true });
	const generation = await writeIsolationOwner(baseDir, "x");
	// Stand-in for ensureIsolation holding the lock across a slow isoStart.
	const held = await acquireFileLock(baseDir);
	const t0 = Date.now();
	let err: unknown;
	try {
		await cleanupIsolation({ mergedDir: path.join(baseDir, "m"), generation, backend: 0 as never, fellBack: false, fallbackReason: null });
	} catch (e) {
		err = e;
	}
	const elapsed = Date.now() - t0;
	held.release();
	console.log("elapsed", elapsed, "error", String(err));
	expect(String(err)).toContain("Failed to acquire lock");
}, 20000);
