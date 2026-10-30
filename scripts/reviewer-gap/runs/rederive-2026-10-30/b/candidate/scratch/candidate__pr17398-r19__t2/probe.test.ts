import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import { getArchivedSessionsDir, materializeSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SESSION_ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
let sessionFile: string;
let archiveFile: string;

function body(id: string, cwd: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
}

async function age() {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const e of await fs.readdir(bucket, { recursive: true })) await fs.utimes(path.join(bucket, e), old, old).catch(() => {});
}
async function archiveOnly() {
	await age();
	return runGcCommand({ flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 } });
}

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-arch-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	await Bun.write(sessionFile, body(SESSION_ID, root));
	archiveFile = path.join(getArchivedSessionsDir(root), "--work--", `${path.basename(sessionFile)}.gz`);
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("P1: artifact deleted after archive is resurrected on open", async () => {
	const live = sessionFile.slice(0, -6);
	await Bun.write(path.join(live, "secret.log"), "DELETE ME");
	const r = await archiveOnly();
	console.log("archive:", JSON.stringify({ archived: r.archive?.archived, errors: r.archive?.errors }));
	console.log("live exists after archive:", await Bun.file(sessionFile).exists(), "archive exists:", await Bun.file(archiveFile).exists());
	// user/tool removes the artifact (or renames the child)
	await fs.rm(path.join(live, "secret.log"));
	const sm = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
	await sm.close();
	console.log("secret.log after open:", await Bun.file(path.join(live, "secret.log")).exists(), await Bun.file(path.join(live, "secret.log")).text().catch(() => "<none>"));
});

test("P1b: renamed artifact: open restores old name beside new", async () => {
	const live = sessionFile.slice(0, -6);
	await Bun.write(path.join(live, "child.log"), "C");
	await archiveOnly();
	await fs.rename(path.join(live, "child.log"), path.join(live, "renamed.log"));
	const sm = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
	await sm.close();
	console.log("entries after open:", (await fs.readdir(live)).sort().join(","));
});

test("P1c: read-only export of a live-owned session whose artifact was removed", async () => {
	const live = sessionFile.slice(0, -6);
	await Bun.write(path.join(live, "a.log"), "A");
	await archiveOnly();
	await fs.rm(path.join(live, "a.log"));
	const lease = tryAcquireSessionLease(SESSION_ID);
	console.log("lease taken by 'other process':", !!lease);
	try {
		const p = await materializeSessionFile(sessionFile, root);
		console.log("materialize ok:", p);
	} catch (e) {
		console.log("materialize error:", (e as Error).message.slice(0, 300));
	} finally {
		lease?.release();
	}
});

test("P2: reclaim deletes a live artifact the archive merely extends", async () => {
	const live = sessionFile.slice(0, -6);
	await Bun.write(path.join(live, "tool.log"), "ORIGINAL CONTENT");
	await archiveOnly();
	await Bun.write(path.join(live, "tool.log"), ""); // truncated / rewritten empty after archive
	const r = await runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true } });
	console.log("reclaim:", JSON.stringify(r.reclaim));
	const rs = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	console.log("restore errors:", JSON.stringify(rs.restore?.errors));
	console.log("tool.log after reclaim+restore:", JSON.stringify(await Bun.file(path.join(live, "tool.log")).text().catch(() => "<none>")));
});
