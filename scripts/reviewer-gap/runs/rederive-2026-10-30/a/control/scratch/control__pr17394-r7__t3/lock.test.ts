import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/utils/src/file-lock.ts";

test("acquireFileLock on a path whose parent does not exist", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lockprobe-"));
	const baseDir = path.join(root, "project-not-yet-created", "task-id");
	let err: unknown;
	try {
		const lock = await acquireFileLock(baseDir, { retries: 2, retryDelayMs: 10 });
		console.log("acquired; lock exists:", fs.existsSync(`${baseDir}.lock`));
		lock.release();
	} catch (e) {
		err = e;
		console.log("threw:", String(e));
	}
	console.log("parent exists after:", fs.existsSync(path.dirname(baseDir)));
	console.log("entries after release:", fs.existsSync(path.dirname(baseDir)) ? fs.readdirSync(path.dirname(baseDir)) : null);
	expect(err).toBeUndefined();
});
