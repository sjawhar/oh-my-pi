// Run as a standalone script: does the owner process ever exit once its own
// (in-process) child session left an unfinished-writer record?
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";

const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "probe-ownwriter-")));
const merged = path.join(base, "m");
await fs.mkdir(merged);
const generation = await writeIsolationOwner(base, "agent-1");
registerIsolationWorkspace(merged, { baseDir: base, generation, agentId: "agent-1" });
// The owner's own child session (same pid) began disposal and abandoned a
// shutdown handler: sdk.ts keeps this record for the life of the process.
await markUnfinishedWriter(merged);
let ran = false;
const deferred = await deferTeardownWhileLeased(merged, async () => {
	ran = true;
}, { generation });
console.log(`deferred=${deferred} base=${base}`);
setTimeout(() => console.log(`after 3s: teardownRan=${ran}; process still alive`), 3000).unref();
