import { afterEach, beforeEach, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SESSION_ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
let sessionFile: string;

function body(id: string, cwd: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
}
async function archiveOnly() {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const e of await fs.readdir(bucket, { recursive: true })) await fs.utimes(path.join(bucket, e), old, old).catch(() => {});
	return runGcCommand({ flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 } });
}
beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-arch2-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	await Bun.write(sessionFile, body(SESSION_ID, root));
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("deleted session comes back by id", async () => {
	await Bun.write(path.join(sessionFile.slice(0, -6), "tool.log"), "PRIVATE");
	await archiveOnly();
	await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile);
	console.log("after delete, live exists:", await Bun.file(sessionFile).exists());
	const match = await resolveResumableSession(SESSION_ID, root);
	console.log("resolve after delete:", match?.scope, match?.session.path);
	if (match) {
		const sm = await SessionManager.open(match.session.path, path.dirname(match.session.path), new FileSessionStorage(), { suppressBreadcrumb: true });
		console.log("opened file:", sm.getSessionFile());
		await sm.close();
		console.log("live exists again:", await Bun.file(sessionFile).exists(), "tool.log:", await Bun.file(path.join(sessionFile.slice(0, -6), "tool.log")).text().catch(() => "<none>"));
	}
});

test("owner forks its own session after an artifact went", async () => {
	const live = sessionFile.slice(0, -6);
	await Bun.write(path.join(live, "a.log"), "A");
	await archiveOnly();
	const owner = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
	// Owner now holds lease. A tool output is pruned.
	await fs.rm(path.join(live, "a.log")).catch(() => {});
	try {
		const forked = await SessionManager.forkFrom(sessionFile, root, path.dirname(sessionFile));
		console.log("fork ok", forked.getSessionFile());
		await forked.close();
	} catch (e) {
		console.log("fork error:", (e as Error).message.slice(0, 220));
	}
	await owner.close();
});
