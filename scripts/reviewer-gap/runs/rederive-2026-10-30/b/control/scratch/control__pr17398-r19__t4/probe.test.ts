import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { getArchivedSessionsDir, materializeSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
let sessionFile: string;

function body(cwd: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "secret prompt" } }),
		JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
}

async function age(): Promise<void> {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const e of await fs.readdir(bucket, { recursive: true }).catch(() => []))
		await fs.utimes(path.join(bucket, e), old, old).catch(() => undefined);
}

async function archive() {
	await age();
	return runGcCommand({
		flags: {
			agentDir: root,
			archive: true,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
}

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-arch-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(sessionFile, body(root));
	const art = sessionFile.slice(0, -6);
	await fs.mkdir(art, { recursive: true });
	await Bun.write(path.join(art, "1.bash.log"), "tool output\n");
});

afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("deleted session resurrects from retained archive", async () => {
	const r = await archive();
	console.log("archive1", JSON.stringify(r.archive));
	await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile);
	console.log("live exists after delete:", await Bun.file(sessionFile).exists());
	const match = await resolveResumableSession(ID, root);
	console.log("resume match scope:", match?.scope, match?.session.path);
	const sm = await SessionManager.open(match!.session.path);
	console.log("opened:", sm.getSessionFile(), "live exists:", await Bun.file(sessionFile).exists());
	console.log("artifact back:", await Bun.file(path.join(sessionFile.slice(0, -6), "1.bash.log")).exists());
});

test("second archive run re-counts already archived", async () => {
	const r1 = await archive();
	const r2 = await archive();
	console.log("run1 archived", r1.archive?.archived, "run2 archived", r2.archive?.archived, r2.archive?.errors);
});

test("missing live artifact + held lease blocks materialize", async () => {
	await archive();
	await fs.rm(path.join(sessionFile.slice(0, -6), "1.bash.log"));
	const lease = await tryAcquireSessionLease(ID);
	console.log("lease acquired:", !!lease);
	try {
		const p = await materializeSessionFile(sessionFile);
		console.log("materialize ok", p, "artifact resurrected:", await Bun.file(path.join(sessionFile.slice(0, -6), "1.bash.log")).exists());
	} catch (e) {
		console.log("materialize threw:", (e as Error).message.slice(0, 300));
	} finally {
		lease?.release?.();
	}
	const p2 = await materializeSessionFile(sessionFile);
	console.log("without lease:", p2, "artifact resurrected:", await Bun.file(path.join(sessionFile.slice(0, -6), "1.bash.log")).exists());
});

test("session moved to another bucket then restore by id duplicates", async () => {
	await archive();
	const archived = path.join(getArchivedSessionsDir(root), "--work--", `2026-01-01T00-00-00-000Z_${ID}.jsonl.gz`);
	console.log("archive exists:", await Bun.file(archived).exists());
	// simulate move: relocate live file to other bucket
	const other = path.join(getSessionsDir(root), "--other--");
	await fs.mkdir(other, { recursive: true });
	const moved = path.join(other, path.basename(sessionFile));
	await fs.rename(sessionFile, moved);
	await fs.rename(sessionFile.slice(0, -6), moved.slice(0, -6));
	const r = await runGcCommand({ flags: { agentDir: root, restore: ID, apply: true, json: true } });
	console.log("restore:", JSON.stringify(r.restore));
	console.log("both live:", await Bun.file(sessionFile).exists(), await Bun.file(moved).exists());
});
