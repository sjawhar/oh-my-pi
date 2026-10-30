import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";

const release = await leaseIsolationWorkspace(process.argv[2]!);
process.stdout.write(`leased pid=${process.pid}\n`);
for await (const _chunk of Bun.stdin.stream()) break;
await release();
process.exit(0);
