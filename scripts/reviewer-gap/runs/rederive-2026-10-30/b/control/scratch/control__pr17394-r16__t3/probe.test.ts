import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/utils/src/file-lock";
import { runStructuredSubagent } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/structured-subagent";
import { ISOLATION_OWNER_FILE } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";

test("caller onRelease is skipped when the workspace lease throws", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-sbx-"));
	await fs.mkdir(path.join(base, "m"), { recursive: true });
	await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ pid: process.pid, retiring: true }));
	let released = 0;
	let error: unknown;
	try {
		await runStructuredSubagent({
			session: { cwd: path.join(base, "m") },
			onRelease: () => {
				released += 1;
			},
		} as never);
	} catch (e) {
		error = e;
	}
	console.log("threw:", error instanceof Error ? error.message : error, "released:", released);
	expect(released).toBe(0);
	await fs.rm(base, { recursive: true, force: true });
});

test("sandbox lock leaves a sibling .lock file behind", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lock-"));
	const sandbox = path.join(root, "t123456789-abc");
	await fs.mkdir(sandbox);
	const lock = await acquireFileLock(sandbox, { retries: 1, retryDelayMs: 1 });
	lock.release();
	await fs.rm(sandbox, { recursive: true, force: true });
	const left = await fs.readdir(root);
	console.log("left in root after release+rm:", left);
	await fs.rm(root, { recursive: true, force: true });
});
