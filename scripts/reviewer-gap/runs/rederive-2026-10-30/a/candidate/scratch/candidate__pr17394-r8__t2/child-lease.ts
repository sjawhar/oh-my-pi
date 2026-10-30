import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";

const merged = process.argv[2]!;
const release = await leaseIsolationWorkspace(merged);
process.stdout.write(`leased pid=${process.pid}\n`);
for await (const _ of console) {
	break;
}
await release();
process.exit(0);
