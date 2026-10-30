// Separate process that opens a lease on a sandbox, like a session another omp process opens there.
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease.ts";

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
	process.exit(0);
}
// mode "hang": wait to be SIGKILLed
await new Promise(() => {});
