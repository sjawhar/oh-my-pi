// Separate-process lease holder: lease argv[2], print LEASED, release on stdin line.
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease.ts";

const release = await leaseIsolationWorkspace(process.argv[2]!);
console.log("LEASED");
for await (const _ of console) {
	await release();
	console.log("RELEASED");
	process.exit(0);
}
