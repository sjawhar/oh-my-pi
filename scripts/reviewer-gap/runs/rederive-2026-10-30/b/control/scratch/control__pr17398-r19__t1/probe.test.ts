import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
let sessionFile: string;
let artifacts: string;

function body(id: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
}

async function archiveOnly() {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const e of await fs.readdir(bucket, { recursive: true })) await fs.utimes(path.join(bucket, e), old, old).catch(() => {});
	return runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
}

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-arch-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(sessionFile, body(ID));
	artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "1.bash.log"), "tool output\n");
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("deleted live artifact resurrected on open", async () => {
	const r = await archiveOnly();
	console.log("archive", JSON.stringify(r.archive));
	await fs.rm(path.join(artifacts, "1.bash.log"));
	const sm = await SessionManager.open(sessionFile);
	console.log("opened", sm.getSessionFile());
	console.log("live artifacts after open:", await fs.readdir(artifacts));
});

test("open of a session while its owner holds the lease, after artifact deleted", async () => {
	await archiveOnly();
	await fs.rm(path.join(artifacts, "1.bash.log"));
	const lease = await tryAcquireSessionLease(ID);
	console.log("lease", !!lease);
	try {
		const sm = await SessionManager.open(sessionFile);
		console.log("opened ok", sm.getSessionFile());
	} catch (e) {
		console.log("open failed:", (e as Error).message);
	}
	try {
		const f = await SessionManager.forkFrom(sessionFile, "/tmp");
		console.log("fork ok", f.getSessionFile());
	} catch (e) {
		console.log("fork failed:", (e as Error).message);
	}
	lease?.release();
});
