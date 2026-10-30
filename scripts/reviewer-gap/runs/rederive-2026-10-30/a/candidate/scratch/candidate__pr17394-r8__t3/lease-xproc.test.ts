import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { registerIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { decideIsolationReclaim, writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";

for (const mode of ["release", "sigkill"]) {
	it(`owner teardown deferred by another process's lease never runs (${mode})`, async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xproc-")));
		const baseDir = path.join(root, "tabc");
		const mergedDir = path.join(baseDir, "m");
		await fs.mkdir(mergedDir, { recursive: true });
		await Bun.write(path.join(mergedDir, "work.txt"), "x");
		const generation = await writeIsolationOwner(baseDir, "id");
		registerIsolationWorkspace(mergedDir);

		const child = Bun.spawn(["bun", path.join(import.meta.dir, "lease-holder.ts"), mergedDir, mode === "release" ? "release" : "hold"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			cwd: process.cwd(),
		});
		const reader = child.stdout.getReader();
		const dec = new TextDecoder();
		let out = "";
		while (!out.includes("LEASED")) out += dec.decode((await reader.read()).value);

		await cleanupIsolation({ mergedDir, generation, backend: natives.IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null } as any);
		console.log(`[${mode}] after cleanupIsolation: baseDir exists =`, await fs.exists(baseDir));

		if (mode === "release") {
			child.stdin.write("go\n");
			child.stdin.flush();
			await child.exited;
		} else {
			child.kill("SIGKILL");
			await child.exited;
		}
		await Bun.sleep(2000);
		console.log(`[${mode}] holder exited code=${child.exitCode} signal=${child.signalCode}`);
		console.log(`[${mode}] 2s after holder gone: baseDir exists =`, await fs.exists(baseDir));
		console.log(`[${mode}] lease dir entries =`, await fs.readdir(path.join(baseDir, ".omp-isolation-leases")).catch(e => String(e)));
		console.log(`[${mode}] decideIsolationReclaim =`, JSON.stringify(await decideIsolationReclaim(baseDir)));
		await fs.rm(root, { recursive: true, force: true });
	}, 30000);
}
