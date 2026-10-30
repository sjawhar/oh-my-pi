import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	hasLiveIsolationLease,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

const HOLDER = path.join(import.meta.dir, "holder.ts");

async function scenario(mode: "release" | "kill") {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-xproc-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(path.join(mergedDir, "sub"), { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	registerIsolationWorkspace(mergedDir);
	const child = Bun.spawn(["bun", HOLDER, path.join(mergedDir, "sub"), mode === "release" ? "release" : "hang"], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = child.stdout.getReader();
	let out = "";
	while (!out.includes("LEASED")) out += new TextDecoder().decode((await reader.read()).value);
	let runs = 0;
	const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
	if (mode === "kill") child.kill("SIGKILL");
	await child.exited;
	await Bun.sleep(2000);
	console.log(
		`[${mode}] deferred=${deferred} holderExit=${child.exitCode ?? child.signalCode} liveLeaseNow=${await hasLiveIsolationLease(baseDir)} teardownRuns=${runs}`,
	);
	await fs.rm(baseDir, { recursive: true, force: true });
}

it("cross-process lease end", async () => {
	await scenario("release");
	await scenario("kill");
}, 30_000);
