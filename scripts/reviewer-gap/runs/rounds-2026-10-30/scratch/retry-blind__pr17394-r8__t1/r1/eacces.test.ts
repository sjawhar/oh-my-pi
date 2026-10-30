import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const SRC = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const lease = await import(`${SRC}/task/isolation-lease.ts`);
const own = await import(`${SRC}/task/isolation-ownership.ts`);

it("unreadable lease dir", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "eacces-probe-"));
	await fs.mkdir(path.join(baseDir, "m", "nested"), { recursive: true });
	// Owner marker naming a dead process (crashed owner).
	await fs.writeFile(path.join(baseDir, own.ISOLATION_OWNER_FILE), JSON.stringify({ pid: 2 ** 22 - 3, id: "x", generation: "g" }));
	const release = await lease.leaseIsolationWorkspace(path.join(baseDir, "m", "nested")); // live lease held by this process
	const leaseDir = path.join(baseDir, lease.ISOLATION_LEASE_DIR);
	console.log("uid", process.getuid?.(), "lease files", await fs.readdir(leaseDir));
	console.log("before chmod:", JSON.stringify(await own.decideIsolationReclaim(baseDir)));
	await fs.chmod(leaseDir, 0o000);
	try {
		console.log("after chmod 000:", JSON.stringify(await own.decideIsolationReclaim(baseDir)), "hasLiveIsolationLease=", await lease.hasLiveIsolationLease(baseDir));
	} finally {
		await fs.chmod(leaseDir, 0o755);
		await release();
	}
});
