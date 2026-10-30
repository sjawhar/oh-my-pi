import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/utils/src/index";
import {
	deferTeardownWhileLeased,
	markUnfinishedWriter,
	registerIsolationWorkspace,
	forgetIsolationWorkspace,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner, SANDBOX_LOCK_WAIT } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";

test("lock file survives release and sandbox removal", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lock-"));
	const sandbox = path.join(root, "t123456789-1");
	await fs.mkdir(sandbox);
	const lock = await acquireFileLock(sandbox, SANDBOX_LOCK_WAIT);
	lock.release();
	await fs.rm(sandbox, { recursive: true, force: true });
	const left = await fs.readdir(root);
	console.log("worktrees root after teardown:", left);
	expect(left).toEqual([]);
});

test("owner's own writer record pins its own sandbox; poll keeps running", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-own-"));
	const baseDir = await fs.realpath(root);
	const merged = path.join(baseDir, "m");
	await fs.mkdir(merged);
	const generation = await writeIsolationOwner(baseDir, "0-Child");
	registerIsolationWorkspace(merged, { baseDir, generation, agentId: "0-Child" });
	// The owner's own child session records itself as an unfinished writer
	// (sdk.ts keeps it for the process lifetime when any handler ever timed out).
	await markUnfinishedWriter(merged);
	let ran = 0;
	const deferred = await deferTeardownWhileLeased(merged, async () => {
		ran += 1;
	}, { generation });
	await Bun.sleep(1000);
	console.log("deferred:", deferred, "teardown ran:", ran);
	forgetIsolationWorkspace(merged, generation);
	expect(deferred).toBe(false);
});
