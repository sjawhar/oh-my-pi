import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasLiveIsolationLease, ISOLATION_LEASE_DIR, ISOLATION_UNFINISHED_DIR } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-lease";
import { decideIsolationReclaim, ISOLATION_OWNER_FILE } from "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership";

async function deadPid(): Promise<number> {
	const p = Bun.spawn(["true"]);
	await p.exited;
	return p.pid;
}

async function sandbox(): Promise<string> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-residue-"));
	await fs.mkdir(path.join(base, "m"));
	// Owner long gone.
	await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "t", generation: "g1" }));
	return base;
}

test("zero-length lease (crash after rename without fsync) pins a dead sandbox forever", async () => {
	const base = await sandbox();
	console.log("baseline:", JSON.stringify(await decideIsolationReclaim(base)));
	await fs.mkdir(path.join(base, ISOLATION_LEASE_DIR));
	await Bun.write(path.join(base, ISOLATION_LEASE_DIR, "12345-1.json"), "");
	console.log("empty lease:", JSON.stringify(await decideIsolationReclaim(base)), "hasLive=", await hasLiveIsolationLease(base));
	// still there after the check: nothing ever retires it
	console.log("lease still present:", await fs.readdir(path.join(base, ISOLATION_LEASE_DIR)));
});

test("half-written temp from writeFileAtomically counts as a lease", async () => {
	const base = await sandbox();
	await fs.mkdir(path.join(base, ISOLATION_LEASE_DIR));
	await Bun.write(path.join(base, ISOLATION_LEASE_DIR, "999-1.json.999.2.tmp"), '{"pid":9');
	console.log("tmp residue:", JSON.stringify(await decideIsolationReclaim(base)));
});

test("truncated writer record pins a dead sandbox forever", async () => {
	const base = await sandbox();
	await fs.mkdir(path.join(base, ISOLATION_UNFINISHED_DIR));
	await Bun.write(path.join(base, ISOLATION_UNFINISHED_DIR, "999-1.json"), "");
	console.log("empty writer:", JSON.stringify(await decideIsolationReclaim(base)));
});
