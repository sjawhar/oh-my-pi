import { afterEach, beforeEach, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-reclaim-open-"));
	setAgentDir(root);
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("reclaim under a resumed-but-idle session", async () => {
	const dir = path.join(getSessionsDir(root), "--work--");
	const art = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}`);
	await fs.mkdir(art, { recursive: true });
	const file = `${art}.jsonl`;
	await Bun.write(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi", timestamp: 1 } }),
			JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [], timestamp: 2 } }),
		].join("\n") + "\n",
	);
	await Bun.write(path.join(art, "out.txt"), "tool output\n");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const e of await fs.readdir(dir, { recursive: true })) await fs.utimes(path.join(dir, e), old, old);
	await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});

	// Process A resumes the session (TUI idle, nothing typed yet).
	const sm = await SessionManager.open(file);
	console.log("A opened:", sm.getSessionFile() === file, "entries:", sm.getEntries().length);

	// Operator reclaims.
	const r = await runGcCommand({ flags: { agentDir: root, reclaim: ID, apply: true, forwardOnly: true, json: true } });
	console.log("reclaimed:", r.reclaim?.reclaimed, "errors:", r.reclaim?.errors);
	console.log("live after reclaim:", await Bun.file(file).exists(), "artifact:", await Bun.file(path.join(art, "out.txt")).exists());

	// A types its next turn.
	sm.appendMessage({ role: "user", content: "next turn", timestamp: Date.now() } as never);
	await sm.flush();
	const exists = await Bun.file(file).exists();
	console.log("live after A writes:", exists);
	if (exists) console.log("live content:\n" + (await Bun.file(file).text()));
	console.log("artifact after A writes:", await Bun.file(path.join(art, "out.txt")).exists());
	const archive = path.join(root, "archive", "sessions", "--work--", `2026-01-01T00-00-00-000Z_${ID}.jsonl.gz`);
	console.log("archive exists:", await Bun.file(archive).exists());
	// A later reopen elsewhere:
	const again = await SessionManager.open(file).catch(e => e as Error);
	console.log("reopen:", again instanceof Error ? `ERROR ${again.message}` : `entries=${again.getEntries().length}`);
	console.log("artifact after reopen:", await Bun.file(path.join(art, "out.txt")).exists());
});
