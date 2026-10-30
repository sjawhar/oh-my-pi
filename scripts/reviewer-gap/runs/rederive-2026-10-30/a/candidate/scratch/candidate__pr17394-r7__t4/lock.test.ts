import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/utils/src/file-lock";
const natives = { IsoBackendKind: { LinuxReflink: 3 } };
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-ownership";
import { cleanupIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";

test("cleanupIsolation vs a materialisation holding the sandbox lock > 5s", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "iso-lock-"));
	const baseDir = path.join(root, "task-abc");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await Bun.write(path.join(mergedDir, "work.txt"), "child work");
	const generation = await writeIsolationOwner(baseDir, "0-Task");
	// Stand-in for ensureIsolation of the same id holding the lock across isoStart (a large copy).
	const held = await acquireFileLock(baseDir);
	const t0 = Date.now();
	let err: unknown;
	try {
		await cleanupIsolation({
			mergedDir,
			generation,
			backend: natives.IsoBackendKind.LinuxReflink,
			fellBack: false,
			fallbackReason: null,
		} as never);
	} catch (e) {
		err = e;
	}
	held.release();
	console.log("elapsed ms:", Date.now() - t0);
	console.log("error:", err instanceof Error ? err.message : String(err));
	console.log("baseDir still exists:", await fs.exists(baseDir));
	await fs.rm(root, { recursive: true, force: true });
}, 20_000);
