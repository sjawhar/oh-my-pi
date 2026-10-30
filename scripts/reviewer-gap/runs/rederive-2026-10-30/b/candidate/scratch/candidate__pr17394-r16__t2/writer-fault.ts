import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	hasUnfinishedWriter,
	ISOLATION_UNFINISHED_DIR,
	leaseIsolationWorkspace,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease";
import {
	resolveSandboxIdentity,
	writeIsolationOwner,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";

console.log("uid", process.getuid?.());
const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-fault-"));
const baseDir = await resolveSandboxIdentity(path.join(root, "tabc-1"));
const merged = path.join(baseDir, "m");
await fs.mkdir(merged, { recursive: true });
const generation = await writeIsolationOwner(baseDir, "owner");
registerIsolationWorkspace(merged, { baseDir, generation, agentId: "owner" });

// A session (not the owner's own: different agent id) opens in the sandbox.
const release = await leaseIsolationWorkspace(merged, { agentId: "other" });
let ran = false;
console.log("deferred while leased:", await deferTeardownWhileLeased(merged, async () => { ran = true; }, { generation }));

// Fault: the unfinished-writer record cannot be written (EACCES on its directory).
await fs.mkdir(path.join(baseDir, ISOLATION_UNFINISHED_DIR));
await fs.chmod(path.join(baseDir, ISOLATION_UNFINISHED_DIR), 0o500);

// What sdk.ts grace timer does: recordWriter().catch(log).finally(dropWorkspaceLease)
await markUnfinishedWriter(merged)
	.then(() => console.log("writer record written"))
	.catch(e => console.log("writer record FAILED:", (e as Error).message))
	.finally(async () => {
		await release();
	});
await Bun.sleep(600);
console.log("hasUnfinishedWriter:", await hasUnfinishedWriter(baseDir));
console.log("owner teardown (capture+delete) ran while the session's shutdown handler may still write:", ran);
process.exit(0);
