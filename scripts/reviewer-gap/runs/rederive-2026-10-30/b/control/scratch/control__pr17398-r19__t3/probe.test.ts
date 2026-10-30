import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/cli/gc-cli";
import { AgentStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/session/agent-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/test/helpers/settings-test-state";
const getSessionsDir = (d: string) => path.join(d, "sessions");

let root: string;
let state: SettingsTestState | undefined;
let spies: { mockRestore(): void }[] = [];
const out: string[] = [];
beforeEach(async () => {
	state = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-probe-"));
	spies = [
		spyOn(process.stdout, "write").mockImplementation(c => (out.push(String(c)), true)),
		spyOn(process.stderr, "write").mockImplementation(c => (out.push(String(c)), true)),
	];
});
afterEach(async () => {
	for (const s of spies) s.mockRestore();
	restoreSettingsTestState(state);
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

const flags = () => ({
	agentDir: root,
	archive: true,
	apply: true,
	coldArchiveAfterDays: 0,
	retainNewestGlobal: 0,
	retainNewestPerCwd: 0,
});

async function age(file: string) {
	const ts = new Date(Date.now() - 90 * 86_400_000);
	await fs.utimes(file, ts, ts);
}

test("repeat archive / rewritten live", async () => {
	const dir = path.join(getSessionsDir(root), "project");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "s1.jsonl");
	const header = JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
	const m1 = JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } });
	const m2 = JSON.stringify({ type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [] } });
	await Bun.write(file, `${header}\n${m1}\n${m2}\n`);
	await Bun.write(path.join(dir, "s1", "0.bash.log"), "tool output");
	await age(file);
	const r1 = await runGcCommand({ flags: flags() });
	console.error("run1", JSON.stringify(r1.archive));
	const r2 = await runGcCommand({ flags: flags() });
	console.error("run2", JSON.stringify(r2.archive));
	// tool output rewritten shorter in live
	await Bun.write(path.join(dir, "s1", "0.bash.log"), "tool");
	await age(file);
	const r3 = await runGcCommand({ flags: flags() });
	console.error("run3 (artifact shrank)", JSON.stringify(r3.archive), process.exitCode);
	// live transcript rewritten (non-prefix)
	const m2b = JSON.stringify({ type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
	await Bun.write(file, `${header}\n${m1}\n${m2b}\n`);
	await age(file);
	const r4 = await runGcCommand({ flags: flags() });
	console.error("run4 (transcript rewritten)", JSON.stringify(r4.archive), process.exitCode);
	console.error("exitCode after run4", process.exitCode);
	const rr = await runGcCommand({ flags: { agentDir: root, restore: "s1", apply: true } });
	console.error("restore per advice", JSON.stringify(rr.restore), process.exitCode);
	const r5 = await runGcCommand({ flags: flags() });
	console.error("run5 after restore", JSON.stringify(r5.archive?.errors).slice(0, 300));
	await fs.rm(path.join(dir, "s1", "0.bash.log"));
	const { materializeSessionFile } = await import("/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/session/session-archive");
	try {
		const p = await materializeSessionFile(file, root);
		console.error("materialize ->", p, await fs.readdir(path.join(dir, "s1")).catch(e => String(e)));
	} catch (e) {
		console.error("materialize threw", String(e).slice(0, 400));
	}
});
