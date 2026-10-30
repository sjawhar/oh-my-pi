import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { getArchivedSessionsDir, materializeSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SESSION_ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
const CHILD_ID = "01a18630-42ae-7117-ba7c-029b1eee0f99";
let root: string;
let originalAgentDir: string;
let sessionFile: string;

function body(id: string, prompt: string, cwd: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: prompt } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
}
const MORE = `${JSON.stringify({ type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "later" } })}\n${JSON.stringify({ type: "message", id: "m4", parentId: "m3", timestamp: "2026-01-02T00:00:01.000Z", message: { role: "assistant", content: [] } })}\n`;

async function age() {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const entry of await fs.readdir(bucket, { recursive: true })) {
		await fs.utimes(path.join(bucket, entry), old, old).catch(() => undefined);
	}
}

async function archive(apply = true) {
	await age();
	return runGcCommand({
		flags: { agentDir: root, archive: true, apply, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
}

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-probe-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	await Bun.write(sessionFile, body(SESSION_ID, "hello", root));
	const art = sessionFile.slice(0, -6);
	await fs.mkdir(art, { recursive: true });
	await Bun.write(path.join(art, "1.bash.log"), "tool output\n");
	await Bun.write(path.join(art, `child_${CHILD_ID}.jsonl`), body(CHILD_ID, "child", root));
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

test("re-running archive on unchanged sessions", async () => {
	const a = await archive();
	console.log("run1", JSON.stringify(a.archive));
	const b = await archive();
	console.log("run2", JSON.stringify(b.archive));
});

test("deleted live artifact after archive, then open", async () => {
	await archive();
	await fs.rm(path.join(sessionFile.slice(0, -6), "1.bash.log"));
	await fs.appendFile(sessionFile, MORE);
	try {
		const out = await materializeSessionFile(sessionFile);
		console.log("materialize ->", out);
		console.log("live tree", await fs.readdir(sessionFile.slice(0, -6)));
		console.log("live tail", (await Bun.file(sessionFile).text()).split("\n").length);
	} catch (e) {
		console.log("materialize threw:", (e as Error).message);
	}
});

test("renamed child after archive, then open", async () => {
	await archive();
	const art = sessionFile.slice(0, -6);
	await fs.rename(path.join(art, `child_${CHILD_ID}.jsonl`), path.join(art, `renamed_${CHILD_ID}.jsonl`));
	try {
		const out = await materializeSessionFile(sessionFile);
		console.log("materialize ->", out);
		console.log("live tree", await fs.readdir(art));
	} catch (e) {
		console.log("materialize threw:", (e as Error).message);
	}
});

test("open live session while I hold lease, with deleted artifact", async () => {
	await archive();
	await fs.rm(path.join(sessionFile.slice(0, -6), "1.bash.log"));
	const lease = await tryAcquireSessionLease(SESSION_ID);
	console.log("lease", !!lease);
	try {
		const sm = await SessionManager.open(sessionFile);
		console.log("open ok", sm.getSessionFile());
	} catch (e) {
		console.log("open threw:", (e as Error).message);
	}
	lease?.release();
});

test("archive after live advanced", async () => {
	await archive();
	await fs.appendFile(sessionFile, MORE);
	await Bun.write(path.join(sessionFile.slice(0, -6), "1.bash.log"), "rewritten\n");
	const r = await archive();
	console.log("rearchive", JSON.stringify(r.archive));
});

test("delete session after archive, then resume by id", async () => {
	const { FileSessionStorage } = await import("@oh-my-pi/pi-coding-agent/session/session-storage");
	const { resolveResumableSession } = await import("@oh-my-pi/pi-coding-agent/session/session-listing");
	await archive();
	await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile);
	console.log("live exists after delete", await Bun.file(sessionFile).exists());
	const match = await resolveResumableSession(SESSION_ID.slice(0, 8), root);
	console.log("resume match", match?.scope, match?.session.path);
	if (match) {
		const sm = await SessionManager.open(match.session.path);
		console.log("reopened", sm.getSessionFile(), "live exists", await Bun.file(sessionFile).exists(), await fs.readdir(sessionFile.slice(0, -6)).catch(() => []));
	}
});

test("follow the printed remedy", async () => {
	await archive();
	await Bun.write(path.join(sessionFile.slice(0, -6), "1.bash.log"), "rewritten\n");
	await archive();
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	console.log("REMEDY restore", JSON.stringify(restored.restore));
	const again = await archive();
	console.log("REMEDY rearchive archived=", again.archive?.archived, "errors=", again.archive?.errors.length);
});
