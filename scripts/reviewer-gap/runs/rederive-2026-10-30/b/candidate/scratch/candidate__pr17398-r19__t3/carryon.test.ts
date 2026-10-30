import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { getArchivedSessionsDir, materializeSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
let sessionFile: string;
let artifacts: string;

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-carryon-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(
		sessionFile,
		`${[
			JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
		].join("\n")}\n`,
	);
	artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "a.log"), "ORIGINAL TOOL OUTPUT");
	await Bun.write(path.join(artifacts, "old-name.log"), "CHILD");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const e of await fs.readdir(dir, { recursive: true })) await fs.utimes(path.join(dir, e), old, old);
	const r = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archive errors:", JSON.stringify(r.archive?.errors), "archived:", r.archive?.archived);
	console.log("archive tree:", await fs.readdir(path.join(getArchivedSessionsDir(root), "--work--"), { recursive: true }));
});
afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("rename only: open resurrects the old name", async () => {
	await fs.rename(path.join(artifacts, "old-name.log"), path.join(artifacts, "new-name.log"));
	const opened = await materializeSessionFile(sessionFile);
	console.log("opened:", opened);
	console.log("live tree after open:", (await fs.readdir(artifacts)).sort());
});

test("rename + rewritten output: open refuses", async () => {
	await fs.rename(path.join(artifacts, "old-name.log"), path.join(artifacts, "new-name.log"));
	await Bun.write(path.join(artifacts, "a.log"), "REWRITTEN");
	try {
		const sm = await SessionManager.open(sessionFile);
		console.log("SessionManager.open ok:", sm.getSessionFile());
	} catch (e) {
		console.log("SessionManager.open threw:", (e as Error).message);
	}
	console.log("live tree after open:", (await fs.readdir(artifacts)).sort());
});
