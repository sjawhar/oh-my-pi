const SRC = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const lease = await import(`${SRC}/task/isolation-lease.ts`);
const release = await lease.leaseIsolationWorkspace(process.argv[2]);
process.stdout.write("leased\n");
if (process.argv[3] === "release") {
	for await (const _ of Bun.stdin.stream()) break;
	await release();
	process.exit(0);
}
await Bun.sleep(60_000);
