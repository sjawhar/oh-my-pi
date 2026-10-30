// Child process: a session "another process opens" inside the sandbox.
const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const lease = await import(`${HEAD}/task/isolation-lease.ts`);
const [cwd, go] = process.argv.slice(2);
const release = await lease.leaseIsolationWorkspace(cwd);
console.log("child leased");
while (!(await Bun.file(go).exists())) await Bun.sleep(20);
await release();
console.log("child released");
