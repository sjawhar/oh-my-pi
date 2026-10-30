import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	hasLiveIsolationLease,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

it("P5: a lease held by another process never runs the owner's deferred teardown", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-xproc-"));
	const baseDir = path.join(root, "tabc");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	registerIsolationWorkspace(mergedDir);
	const child = Bun.spawn(["bun", path.join(import.meta.dir, "xproc-child.ts"), mergedDir], { stdout: "pipe" });
	const reader = child.stdout.getReader();
	await reader.read(); // "leased"
	let runs = 0;
	const deferred = await deferTeardownWhileLeased(mergedDir, async () => {
		runs += 1; // stands in for captureAndCleanup
	});
	await child.exited;
	await Bun.sleep(2000);
	console.log("P5 deferred:", deferred, "| child exit:", child.exitCode);
	console.log("P5 leases left:", await hasLiveIsolationLease(baseDir), "| deferred teardown runs after 2s:", runs);
	console.log("P5 sandbox still on disk:", await fs.stat(mergedDir).then(() => true, () => false));
	await fs.rm(root, { recursive: true, force: true });
}, 10_000);
