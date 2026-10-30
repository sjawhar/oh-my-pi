import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
const SRC = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/coding-agent/src";
const { runGcCommand } = await import(`${SRC}/cli/gc-cli.ts`);
const { AgentStorage } = await import(`${SRC}/session/agent-storage.ts`);
const { getSessionsDir } = await import("/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/e43656228da50276c8d2a5d50b4e0809efb373cf/packages/utils/src/index.ts");

let root: string;
let out: { mockRestore(): void };
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sup-"));
	out = spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
	out.mockRestore();
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

const flags = () => ({
	agentDir: root,
	archive: true,
	forwardOnly: true,
	apply: true,
	coldArchiveAfterDays: 1,
	retainNewestGlobal: 0,
	retainNewestPerCwd: 0,
});

async function age(file: string) {
	const ts = new Date(Date.now() - 10 * 86_400_000);
	await fs.utimes(file, ts, ts);
}

test("supersede: archive replaced before verification, verification failure keeps the unverified copy", async () => {
	const dir = path.join(getSessionsDir(root), "proj");
	await fs.mkdir(dir, { recursive: true });
	const live = path.join(dir, "2026-01-01T00-00-00-000Z_sup1.jsonl");
	const header = JSON.stringify({ type: "session", version: 3, id: "sup1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
	const turn1 = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ARCHIVED-ONLY-TURN" }] } });
	const original = `${header}\n${turn1}\n`;
	await Bun.write(live, original);
	await age(live);
	const first = await runGcCommand({ flags: flags() });
	console.log("first run", JSON.stringify(first.archive?.errors), "archived", first.archive?.archived);
	const archive = path.join(root, "archive", "sessions", "proj", "2026-01-01T00-00-00-000Z_sup1.jsonl.gz");
	console.log("archive v1 =", JSON.stringify(gunzipSync(await fs.readFile(archive)).toString()));

	// Session carried on: live now longer, so the next run takes the supersede path.
	const turn2 = JSON.stringify({ type: "message", message: { role: "assistant", content: [] } });
	const carried = `${original}${turn2}\n`;
	await Bun.write(live, carried);
	await age(live);

	// Window: between gzipSessionFile's digest (T1) and its gzip read (T2) the live
	// file holds other bytes; it is back before the supersede proof reads `source` by path.
	const other = `${header}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`;
	const rm = fs.rm.bind(fs);
	const lstat = fs.lstat.bind(fs);
	let phase = 0;
	const rmSpy = spyOn(fs, "rm").mockImplementation(async (p: any, o: any) => {
		if (phase === 0 && String(p).includes(".jsonl.gz.") && String(p).endsWith(".tmp")) {
			phase = 1;
			await Bun.write(live, other);
		}
		return rm(p, o);
	});
	const lstatSpy = spyOn(fs, "lstat").mockImplementation(async (p: any, o?: any) => {
		if (phase === 1 && String(p).includes(".jsonl.gz.") && String(p).endsWith(".tmp")) {
			phase = 2;
			await Bun.write(live, carried);
			await age(live);
		}
		return lstat(p, o);
	});
	let second;
	try {
		second = await runGcCommand({ flags: flags() });
	} finally {
		rmSpy.mockRestore();
		lstatSpy.mockRestore();
	}
	console.log("phase", phase);
	console.log("second run errors", JSON.stringify(second.archive?.errors));
	const after = gunzipSync(await fs.readFile(archive)).toString();
	console.log("archive v2 =", JSON.stringify(after));
	console.log("live =", JSON.stringify(await Bun.file(live).text()));
	console.log("archive still holds ARCHIVED-ONLY-TURN:", after.includes("ARCHIVED-ONLY-TURN"));
});
