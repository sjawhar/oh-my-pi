import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
const CHILD = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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

async function age(): Promise<void> {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const e of await fs.readdir(bucket, { recursive: true })) await fs.utimes(path.join(bucket, e), old, old);
}

async function tree(dir: string): Promise<string[]> {
	return (await fs.readdir(dir, { recursive: true }).catch(() => [])).sort();
}

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-reclaim-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(sessionFile, body(ID, root));
	const art = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(art, { recursive: true });
	await Bun.write(path.join(art, `child_${CHILD}.jsonl`), body(CHILD, root));
	await Bun.write(path.join(art, "tool.log"), "TOOL OUTPUT");
	archiveFile = path.join(root, "archive", "sessions", "--work--", `${path.basename(sessionFile)}.gz`);
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("reclaim deletes a session another manager has open (resumed, not yet written)", async () => {
	await age();
	const a = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archive errors:", a.archive?.errors, "archived:", a.archive?.archived);

	// A user resumes the session: `omp --resume <id>` → SessionManager.open.
	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	console.log("open, entries:", manager.getEntries().length);

	// Meanwhile an operator reclaims it.
	const r = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});
	console.log("reclaim:", JSON.stringify({ reclaimed: r.reclaim?.reclaimed, errors: r.reclaim?.errors }));
	console.log("live transcript exists after reclaim:", await Bun.file(sessionFile).exists());
	console.log("live artifacts after reclaim:", await tree(sessionFile.slice(0, -6)));

	// The open session now takes its next turn.
	manager.appendMessage({ role: "user", content: "next turn", timestamp: Date.now() } as never);
	await manager.flush();
	console.log("live transcript exists after write:", await Bun.file(sessionFile).exists());
	const text = await Bun.file(sessionFile).text().catch(() => "<missing>");
	console.log("live transcript lines:", text.trim().split("\n").length);
	console.log("live artifacts after write:", await tree(sessionFile.slice(0, -6)));
	console.log("live transcript content:", text);
	await manager.close();
	const again = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	}).then(
		m => `opened, entries=${m.getEntries().length}`,
		e => `open failed: ${e instanceof Error ? e.message : String(e)}`,
	);
	console.log("re-resume:", again);
	expect(r.reclaim?.reclaimed).toBe(0);
});
