// Second process: opens a lease on the sandbox like a session another process opens there.
import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";

const cwd = process.argv[2]!;
const mode = process.argv[3] ?? "release";
const release = await leaseIsolationWorkspace(cwd);
console.log("LEASED");
// wait for a line on stdin
for await (const _ of console) {
	break;
}
if (mode === "release") {
	await release();
	console.log("RELEASED");
}
process.exit(0);
