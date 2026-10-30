// Process B: a session opened in someone else's sandbox (what sdk.ts does at createAgentSession).
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease.ts";

const cwd = process.argv[2]!;
const mode = process.argv[3] ?? "release";
const release = await leaseIsolationWorkspace(cwd);
console.log("LEASED");
for await (const _line of console) {
	if (mode === "release") {
		await release();
		console.log("RELEASED");
		process.exit(0);
	}
	break;
}
