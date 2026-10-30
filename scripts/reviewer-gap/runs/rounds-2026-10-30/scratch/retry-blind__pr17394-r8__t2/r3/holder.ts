import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";

const cwd = process.argv[2]!;
const mode = process.argv[3]!; // "release" | "hang"
const release = await leaseIsolationWorkspace(cwd);
console.log("LEASED");
if (mode === "release") {
	await Bun.sleep(500);
	await release();
	console.log("RELEASED");
	process.exit(0);
}
await Bun.sleep(60_000);
