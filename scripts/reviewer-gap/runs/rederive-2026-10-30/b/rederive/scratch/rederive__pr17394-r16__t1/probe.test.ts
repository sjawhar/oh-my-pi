import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/node_modules/@oh-my-pi/pi-natives";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasUnfinishedWriter,
	leaseIsolationWorkspace,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";
import { cleanupIsolation } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/worktree";

async function makeSandbox(root: string, name: string) {
	const baseDir = await fs.realpath(await fs.mkdtemp(path.join(root, `${name}-`)));
	const generation = await writeIsolationOwner(baseDir, "owner-task");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await Bun.write(path.join(mergedDir, "work.txt"), "child work");
	return { baseDir, mergedDir, generation };
}

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

// sdk.ts:4496 leases sandbox from getCwd() at session start; sdk.ts:4506
// re-derives the sandbox from getCwd() at disposal. A moveTo() in between
// sends the writer record elsewhere, the lease drops, and the owner's
// deferred teardown deletes the directory the abandoned handler is writing.
test("D1: writer record re-derived from current cwd misses the leased sandbox", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rederive-d1-"));
	const sb = await makeSandbox(root, "t1");
	registerIsolationWorkspace(sb.mergedDir, { baseDir: sb.baseDir, generation: sb.generation, agentId: "owner-task" });
	let cwd = sb.mergedDir; // sessionManager.getCwd()
	const workspaceLease = await leaseIsolationWorkspace(cwd, { agentId: "foreign-session" }); // T1
	let teardownRan = false;
	const deferred = await deferTeardownWhileLeased(
		sb.mergedDir,
		async () => {
			teardownRan = true;
			await fs.rm(sb.baseDir, { recursive: true, force: true });
		},
		{ generation: sb.generation },
	);
	console.log("deferred while leased:", deferred);
	// session.moveTo(elsewhere) — /move during the session
	cwd = await fs.mkdtemp(path.join(root, "elsewhere-"));
	// disposal with abandoned shutdown work: recordWriter() then dropWorkspaceLease()
	await markUnfinishedWriter(cwd); // T2
	console.log("hasUnfinishedWriter(leased sandbox):", await hasUnfinishedWriter(sb.baseDir));
	await workspaceLease();
	console.log("teardown ran:", teardownRan, "sandbox exists:", await exists(sb.baseDir));
	forgetIsolationWorkspace(sb.mergedDir);
	expect(teardownRan).toBe(false);
});

// Control: same sequence without the cwd move keeps the sandbox.
test("D1 control: record in the leased sandbox keeps it", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rederive-d1c-"));
	const sb = await makeSandbox(root, "t1");
	registerIsolationWorkspace(sb.mergedDir, { baseDir: sb.baseDir, generation: sb.generation, agentId: "owner-task" });
	const workspaceLease = await leaseIsolationWorkspace(sb.mergedDir, { agentId: "foreign-session" });
	let teardownRan = false;
	await deferTeardownWhileLeased(sb.mergedDir, async () => {
		teardownRan = true;
	}, { generation: sb.generation });
	await markUnfinishedWriter(sb.mergedDir);
	await workspaceLease();
	console.log("control teardown ran:", teardownRan);
	forgetIsolationWorkspace(sb.mergedDir);
	expect(teardownRan).toBe(false);
});

// markUnfinishedWriter takes no sandbox lock and checks no claim, so a record
// written after cleanupIsolation's hasUnfinishedWriter check (worktree.ts
// cleanupIsolation, under the lock) is never consulted again.
test("D2: unfinished-writer record written during locked capture is ignored", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rederive-d2-"));
	const sb = await makeSandbox(root, "t2");
	registerIsolationWorkspace(sb.mergedDir, { baseDir: sb.baseDir, generation: sb.generation, agentId: "owner-task" });
	let recordWritten = false;
	await cleanupIsolation(
		{ mergedDir: sb.mergedDir, generation: sb.generation, backend: natives.IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null },
		{
			capture: async () => {
				await markUnfinishedWriter(sb.mergedDir);
				recordWritten = true;
				console.log("record visible mid-capture:", await hasUnfinishedWriter(sb.baseDir));
			},
		},
	);
	console.log("record written:", recordWritten, "sandbox exists after cleanup:", await exists(sb.baseDir));
	expect(await exists(sb.baseDir)).toBe(true);
});
