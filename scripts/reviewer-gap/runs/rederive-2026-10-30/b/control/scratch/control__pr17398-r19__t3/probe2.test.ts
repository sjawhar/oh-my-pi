import { afterEach, beforeEach, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/cli/gc-cli";
import { AgentStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/session/agent-storage";
import { materializeSessionFile } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src/session/session-archive";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/test/helpers/settings-test-state";

let root: string;
let state: SettingsTestState | undefined;
let spies: { mockRestore(): void }[] = [];
beforeEach(async () => {
	state = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-probe-"));
	spies = [
		spyOn(process.stdout, "write").mockImplementation(() => true),
		spyOn(process.stderr, "write").mockImplementation(() => true),
	];
});
afterEach(async () => {
	for (const s of spies) s.mockRestore();
	restoreSettingsTestState(state);
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

const flags = () => ({ agentDir: root, archive: true, apply: true, coldArchiveAfterDays: 0, retainNewestGlobal: 0, retainNewestPerCwd: 0 });

for (const mode of ["append", "rewrite-header"] as const) {
	test(`renamed child after archive, transcript ${mode}`, async () => {
		const dir = path.join(root, "sessions", "project");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "s1.jsonl");
		const header = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" };
		const m1 = JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [] } });
		await Bun.write(file, `${JSON.stringify(header)}\n${m1}\n`);
		const child = { type: "session", version: 3, id: "c1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" };
		await Bun.write(path.join(dir, "s1", "0-Old.jsonl"), `${JSON.stringify(child)}\n${m1}\n`);
		const ts = new Date(Date.now() - 90 * 86_400_000);
		await fs.utimes(file, ts, ts);
		await fs.utimes(path.join(dir, "s1", "0-Old.jsonl"), ts, ts);
		const r1 = await runGcCommand({ flags: flags() });
		const s = (globalThis as any).console;
		s.error("archived", r1.archive?.archived, r1.archive?.errors);
		await fs.rename(path.join(dir, "s1", "0-Old.jsonl"), path.join(dir, "s1", "0-New.jsonl"));
		if (mode === "append") {
			await fs.appendFile(file, `${JSON.stringify({ type: "message", id: "b", parentId: "a", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "more" } })}\n`);
		} else {
			await Bun.write(file, `${JSON.stringify({ ...header, additionalDirectories: ["/x"] })}\n${m1}\n`);
		}
		try {
			const p = await materializeSessionFile(file, root);
			s.error(mode, "materialize ->", path.basename(p), await fs.readdir(path.join(dir, "s1")));
		} catch (e) {
			s.error(mode, "materialize threw:", String(e).slice(0, 300));
		}
	});
}
