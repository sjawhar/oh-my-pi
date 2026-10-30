import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

it("owner deferral racing the last lease release loses the teardown", async () => {
	const trials = 200;
	let lost = 0;
	for (let i = 0; i < trials; i++) {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "race-"));
		const mergedDir = path.join(baseDir, "m");
		await fs.mkdir(mergedDir, { recursive: true });
		await writeIsolationOwner(baseDir, "id");
		registerIsolationWorkspace(mergedDir);
		// e.g. the isolated child's own session lease from sdk.ts, released by
		// a `void workspaceLease()` dispose callback while the owner's release runs.
		const release = await leaseIsolationWorkspace(mergedDir);
		let ran = 0;
		const deferral = deferTeardownWhileLeased(mergedDir, async () => void (ran += 1));
		const rel = release();
		const [deferred] = await Promise.all([deferral, rel]);
		await Bun.sleep(5);
		if (deferred && ran === 0 && !(await hasLiveIsolationLease(baseDir))) lost += 1;
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.log(`deferred-but-never-run teardowns: ${lost}/${trials}`);
}, 60000);
