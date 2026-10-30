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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-revive-"));
	setAgentDir(root);
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("artifact removed after archive is resurrected by an ordinary open", async () => {
	const dir = path.join(getSessionsDir(root), "--work--");
	const art = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}`);
	await fs.mkdir(path.join(art, "annotate"), { recursive: true });
	const file = `${art}.jsonl`;
	await Bun.write(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
		].join("\n") + "\n",
	);
	const draft = path.join(art, "annotate", "draft-x.json");
	await Bun.write(draft, '{"draft":1}');
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const e of await fs.readdir(dir, { recursive: true })) await fs.utimes(path.join(dir, e), old, old);
	const r = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archived:", r.archive?.archived, r.archive?.errors);
	// The live session carries on and discards its draft.
	await fs.rm(draft);
	console.log("draft exists before open:", await Bun.file(draft).exists());
	const sm = await SessionManager.open(file);
	console.log("opened:", sm.getSessionFile());
	console.log("draft exists after open:", await Bun.file(draft).exists());
});
