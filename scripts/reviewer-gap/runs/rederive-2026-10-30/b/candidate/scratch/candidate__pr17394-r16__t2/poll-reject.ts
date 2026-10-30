import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/utils/src/index";
import {
	deferTeardownWhileLeased,
	ISOLATION_LEASE_DIR,
	registerIsolationWorkspace,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease";
import {
	resolveSandboxIdentity,
	writeIsolationOwner,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";

const t0 = Date.now();
process.on("unhandledRejection", reason => {
	console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] UNHANDLED REJECTION:`, String(reason));
	process.exit(3);
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "poll-reject-"));
const baseDir = await resolveSandboxIdentity(path.join(root, "tabc-1"));
const merged = path.join(baseDir, "m");
await fs.mkdir(merged, { recursive: true });
const generation = await writeIsolationOwner(baseDir, "owner");
registerIsolationWorkspace(merged, { baseDir, generation, agentId: "owner" });

// A foreign live user: another process holding a lease.
const sleeper = Bun.spawn(["sleep", "1000"]);
await fs.mkdir(path.join(baseDir, ISOLATION_LEASE_DIR), { recursive: true });
await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, `${sleeper.pid}-x.json`), JSON.stringify({ pid: sleeper.pid }));

const deferred = await deferTeardownWhileLeased(merged, async () => console.log("teardown ran"), { generation });
console.log(`deferred=${deferred}`);

// Something else (a clear --all, a long removal) holds the sandbox lock for > 60s.
const held = await acquireFileLock(baseDir);
console.log("holding sandbox lock; waiting for the poll's lock budget (60s) to run out");
setTimeout(() => {
	console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] no rejection observed`);
	held.release();
	sleeper.kill();
	process.exit(0);
}, 75_000);
