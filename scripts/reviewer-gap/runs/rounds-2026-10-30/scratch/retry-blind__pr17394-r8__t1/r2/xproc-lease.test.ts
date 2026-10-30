import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	registerIsolationWorkspace,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-lease";
import {
	decideIsolationReclaim,
	writeIsolationOwner,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src/task/isolation-ownership";

const HOLDER = path.join(import.meta.dir, "lease-holder.ts");
const PKG = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent";

async function run(mode: "clean" | "sigkill") {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xlease-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "x");
	registerIsolationWorkspace(mergedDir); // this process materialised it
	const child = Bun.spawn(["bun", HOLDER, path.join(mergedDir, "sub")], {
		cwd: PKG,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = child.stdout.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	let teardowns = 0;
	const deferred = await deferTeardownWhileLeased(mergedDir, async () => {
		teardowns += 1;
	});
	if (mode === "clean") {
		child.stdin.write("release\n");
		child.stdin.end();
	} else {
		child.kill("SIGKILL");
	}
	await child.exited;
	await Bun.sleep(1000);
	const liveLease = await hasLiveIsolationLease(baseDir);
	await Bun.sleep(500);
	const decision = await decideIsolationReclaim(baseDir);
	console.error(
		`mode=${mode} holder=${first.trim()} deferred=${deferred} childExit=${child.exitCode}/${child.signalCode} liveLeaseAfter=${liveLease} teardownsRun=${teardowns} reclaim=${JSON.stringify(decision)}`,
	);
	forgetIsolationWorkspace(mergedDir);
	await fs.rm(baseDir, { recursive: true, force: true });
}

it("cross-process lease, clean release", async () => run("clean"), 20000);
it("cross-process lease, SIGKILL", async () => run("sigkill"), 20000);
