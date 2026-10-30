import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { materializeSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let original: string;
let live: string;
let liveArtifacts: string;

beforeEach(async () => {
	original = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-archive-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	live = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(
		live,
		`${[
			JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
		].join("\n")}\n`,
	);
	liveArtifacts = live.slice(0, -".jsonl".length);
	await fs.mkdir(liveArtifacts, { recursive: true });
	await Bun.write(path.join(liveArtifacts, "1.bash.log"), "old tool output\n");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const e of await fs.readdir(dir, { recursive: true })) await fs.utimes(path.join(dir, e), old, old);
	const r = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archive phase:", JSON.stringify({ archived: r.archive?.archived, errors: r.archive?.errors }));
});

afterEach(async () => {
	setAgentDir(original);
	await fs.rm(root, { recursive: true, force: true });
});

test("A: live artifact emptied after archive -> session can never be opened", async () => {
	// The live session carries on and a tool rewrites its output file empty.
	await Bun.write(path.join(liveArtifacts, "1.bash.log"), "");
	for (const attempt of [1, 2]) {
		try {
			const p = await materializeSessionFile(live);
			console.log(`A attempt ${attempt}: opened`, p);
		} catch (e) {
			console.log(`A attempt ${attempt}: materialize threw: ...`, (e as Error).message.slice(-330));
		}
	}
	try {
		await SessionManager.open(live);
		console.log("A: SessionManager.open succeeded");
	} catch (e) {
		console.log("A: SessionManager.open threw:", (e as Error).message.slice(0, 160));
	}
});

test("B: live artifact deleted after archive -> opening resurrects it", async () => {
	await fs.rm(path.join(liveArtifacts, "1.bash.log"));
	const p = await materializeSessionFile(live);
	const back = await Bun.file(path.join(liveArtifacts, "1.bash.log")).text().catch(() => "<absent>");
	console.log("B: opened", path.basename(p), "deleted artifact now holds:", JSON.stringify(back));
});

test("C: caller owns the session (fork of own session) with a deleted artifact -> refuses", async () => {
	await fs.rm(path.join(liveArtifacts, "1.bash.log"));
	const lease = tryAcquireSessionLease(ID);
	expect(lease).not.toBeNull();
	try {
		await materializeSessionFile(live);
		console.log("C: opened");
	} catch (e) {
		console.log("C: materialize threw:", (e as Error).message.slice(0, 200));
	} finally {
		lease?.release();
	}
});
