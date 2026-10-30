import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SESSION_ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
let root: string;
let orig: string;
let sessionFile: string;
let artifacts: string;

beforeEach(async () => {
	orig = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-retained-"));
	setAgentDir(root);
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	await Bun.write(
		sessionFile,
		`${[
			JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
			JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
		].join("\n")}\n`,
	);
	artifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(artifacts, "0.bash.log"), "TOOL OUTPUT");
	await Bun.write(path.join(artifacts, "1.bash.log"), "OTHER OUTPUT");
	const old = new Date(Date.now() - 30 * 86_400_000);
	for (const e of await fs.readdir(dir, { recursive: true })) await fs.utimes(path.join(dir, e), old, old);
	// The default flow after this patch: archive, keep the live copy.
	const r = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	console.log("archived:", r.archive?.archived, "errors:", r.archive?.errors);
});

afterEach(async () => {
	setAgentDir(orig);
	await fs.rm(root, { recursive: true, force: true });
});

test("A: live artifact emptied after archive, then resume", async () => {
	await Bun.write(path.join(artifacts, "0.bash.log"), "");
	let err: unknown;
	try {
		const m = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
		await m.close();
	} catch (e) {
		err = e;
	}
	console.log("A open error:\n", err instanceof Error ? err.message.replaceAll(root, "$ROOT").split(/(?<=[.:;]) /).join("\n ") : err);
	console.log("A 0.bash.log now:", JSON.stringify(await Bun.file(path.join(artifacts, "0.bash.log")).text()));
});

test("B: live artifact deleted after archive, then resume", async () => {
	await fs.rm(path.join(artifacts, "1.bash.log"));
	let err: unknown;
	try {
		const m = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
		await m.close();
	} catch (e) {
		err = e;
	}
	console.log("B open error:", err instanceof Error ? err.message : err);
	console.log("B 1.bash.log exists again:", await Bun.file(path.join(artifacts, "1.bash.log")).exists());
});

test("C: owner deletes an artifact then forks its own session", async () => {
	const owner = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
	await fs.rm(path.join(artifacts, "1.bash.log"));
	const lease = tryAcquireSessionLease(SESSION_ID); // what the running omp that owns this session holds
	console.log("C lease taken:", lease !== null);
	let err: unknown;
	try {
		const f = await SessionManager.forkFrom(sessionFile, root, path.dirname(sessionFile), new FileSessionStorage(), { suppressBreadcrumb: true });
		await f.close();
	} catch (e) {
		err = e;
	}
	await owner.close();
	lease?.release();
	console.log("C 1.bash.log exists:", await Bun.file(path.join(artifacts, "1.bash.log")).exists());
	console.log("C fork error:", err instanceof Error ? err.message : err);
});
