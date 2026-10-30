import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-resurrect-"));
	setAgentDir(root);
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("deleted session comes back after gc --archive", async () => {
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(path.join(dir, `2026-01-01T00-00-00-000Z_${ID}`), { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "SECRET-TOKEN-abc" } }),
			JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
		].join("\n") + "\n",
	);
	await Bun.write(path.join(dir, `2026-01-01T00-00-00-000Z_${ID}`, "out.txt"), "tool output\n");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const e of await fs.readdir(dir, { recursive: true })) await fs.utimes(path.join(dir, e), old, old);
	const r = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archived:", r.archive?.archived, "errors:", r.archive?.errors);

	// The user deletes the session through the picker / /delete path.
	await new FileSessionStorage().deleteSessionWithArtifacts(file);
	console.log("live exists after delete:", await Bun.file(file).exists());

	const match = await resolveResumableSession(ID, root);
	console.log("resolve after delete:", match?.scope, match?.session.path);
	if (match) {
		const sm = await SessionManager.open(match.session.path);
		console.log("reopened at:", sm.getSessionFile());
		console.log("live exists after resume:", await Bun.file(file).exists());
		console.log("content contains secret:", (await Bun.file(file).text()).includes("SECRET-TOKEN-abc"));
		console.log("artifact back:", await Bun.file(path.join(dir, `2026-01-01T00-00-00-000Z_${ID}`, "out.txt")).exists());
	}
});
