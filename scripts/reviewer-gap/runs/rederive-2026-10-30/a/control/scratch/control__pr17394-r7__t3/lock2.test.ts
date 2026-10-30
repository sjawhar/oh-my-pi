import { test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/utils/src/file-lock.ts";

test("second acquire while first held (models cleanup vs. long isoStart)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lockprobe-"));
	const baseDir = path.join(root, "task-id");
	const first = await acquireFileLock(baseDir);
	const t0 = Date.now();
	try {
		await acquireFileLock(baseDir);
		console.log("second acquired (no exclusion) after", Date.now() - t0, "ms");
	} catch (e) {
		console.log("second threw after", Date.now() - t0, "ms:", String(e));
	}
	first.release();
});
