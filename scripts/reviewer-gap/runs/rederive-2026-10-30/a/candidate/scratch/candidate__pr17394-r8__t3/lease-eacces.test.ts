import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasLiveIsolationLease, ISOLATION_LEASE_DIR } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { decideIsolationReclaim } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

it("an unreadable lease directory reads as 'no lease'", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "eacces-"));
	await fs.mkdir(path.join(baseDir, "m"));
	// crashed owner
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	await Bun.write(path.join(baseDir, ".omp-isolation-owner.json"), JSON.stringify({ pid: dead.pid, id: "x", generation: "g" }));
	const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
	await Bun.write(path.join(leaseDir, "live.json"), JSON.stringify({ pid: process.pid }));
	console.log("readable:   hasLive =", await hasLiveIsolationLease(baseDir), JSON.stringify(await decideIsolationReclaim(baseDir)));
	await fs.chmod(leaseDir, 0o000);
	console.log("readdir err:", await fs.readdir(leaseDir).then(() => "none", e => e.code));
	console.log("unreadable: hasLive =", await hasLiveIsolationLease(baseDir), JSON.stringify(await decideIsolationReclaim(baseDir)));
	await fs.chmod(leaseDir, 0o755);
	console.log("live lease file still present:", await fs.readdir(leaseDir));
	await fs.rm(baseDir, { recursive: true, force: true });
});
