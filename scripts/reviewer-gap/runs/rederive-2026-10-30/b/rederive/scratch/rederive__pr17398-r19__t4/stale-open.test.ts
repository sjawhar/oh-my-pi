import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/cli/gc-cli";
import { withGcLock } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/session/gc-lock";
import { SessionManager } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/session/session-manager";
import { getAgentDir, getSessionsDir, setAgentDir } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/utils/src/index.ts";

const ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let original: string;
let sessionFile: string;

beforeEach(async () => {
	original = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-stale-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	await Bun.write(
		sessionFile,
		`${[
			JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "one", timestamp: 1 } }),
			JSON.stringify({ type: "message", id: "a1", parentId: "m1", timestamp: "2026-01-01T00:00:01.500Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 1 } }),
		].join("\n")}\n`,
	);
	const art = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(art, { recursive: true });
	await Bun.write(path.join(art, "out.txt"), "tool output");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const f of [sessionFile, path.join(art, "out.txt"), art]) await fs.utimes(f, old, old);
	const r = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archive:", JSON.stringify({ archived: r.archive?.archived, errors: r.archive?.errors }));
	// What a kill between "transcript published" and "artifacts carried home" leaves.
	await fs.rm(art, { recursive: true });
});

afterEach(async () => {
	setAgentDir(original);
	await fs.rm(root, { recursive: true, force: true });
});

test("open of live transcript adopts snapshot read before the gc-lock wait", async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	let locked!: () => void;
	const isLocked = new Promise<void>(r => (locked = r));
	const holder = withGcLock(root, async () => {
		locked();
		await gate;
	});
	await isLocked;
	const opening = SessionManager.open(sessionFile, undefined, undefined, { throwIfMissing: true });
	let opened = false;
	opening.then(() => (opened = true), () => (opened = true));
	await Bun.sleep(300); // open has read its snapshot and is waiting on gc.lock inside materializeSessionFile
	console.log("open still pending at append (waiting on gc.lock):", !opened);
	// Another process appends a turn while this one waits.
	await fs.appendFile(
		sessionFile,
		`${JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "two-written-during-wait", timestamp: 2 } })}\n`,
	);
	release();
	await holder;
	const manager = await opening;
	const ids = manager.getEntries().map(e => e.id);
	console.log("manager entries:", ids);
	console.log("file lines:", (await fs.readFile(sessionFile, "utf8")).trim().split("\n").length);
	console.log("artifact restored:", await Bun.file(path.join(sessionFile.slice(0, -6), "out.txt")).exists());
	manager.appendMessage({ role: "user", content: "three", timestamp: 3 } as never);
	await manager.flush();
	await manager.close();
	const after = await fs.readFile(sessionFile, "utf8");
	console.log("after append contains m2:", after.includes("two-written-during-wait"));
	console.log("after append contains three:", after.includes('"three"'));
	console.log(after);
	expect(ids).toContain("m2");
});
