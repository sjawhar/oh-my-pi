import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";

for (const flags of [
	{ restore: "abc", archive: true, apply: true },
	{ reclaim: "abc", archive: true, apply: true, forwardOnly: true },
	{ reclaim: "abc", apply: true, forwardOnly: true },
	{ restore: "abc", apply: true },
]) {
	test(`refused/no-op gc ${JSON.stringify(flags)} leaves legacy settings alone`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-"));
		await Bun.write(path.join(root, "settings.json"), JSON.stringify({ theme: "dark" }));
		let outcome = "ok";
		try {
			const r = await runGcCommand({ flags: { agentDir: root, json: true, ...flags } });
			outcome = `result errors=${JSON.stringify(r.restore?.errors ?? r.reclaim?.errors)}`;
		} catch (e) {
			outcome = `threw: ${(e as Error).message}`;
		}
		console.log(JSON.stringify(flags), "->", outcome.slice(0, 160));
		console.log("  dir now:", (await fs.readdir(root)).sort().join(", "));
		await fs.rm(root, { recursive: true, force: true });
	});
}
