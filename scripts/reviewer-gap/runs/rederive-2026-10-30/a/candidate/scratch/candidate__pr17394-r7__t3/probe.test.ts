import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}
async function repo(): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await git(d, ["init", "-q", "-b", "main"]);
	await git(d, ["config", "user.email", "a@b"]);
	await git(d, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(d, "a.txt"), "a\n");
	await git(d, ["add", "."]);
	await git(d, ["commit", "-q", "-m", "x"]);
	return d;
}
function rcopy() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}

it("S1: old teardown's forget erases successor's lease registration", async () => {
	rcopy();
	const r = await repo();
	setWorktreesDir(await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-")));
	const old = await ensureIsolation(r, "reused");
	const bulk = path.join(old.mergedDir, "bulk");
	await fs.mkdir(bulk);
	for (let i = 0; i < 200; i++) {
		const d = path.join(bulk, String(i));
		await fs.mkdir(d);
		await Promise.all(Array.from({ length: 150 }, (_, j) => fs.writeFile(path.join(d, String(j)), "x")));
	}
	const t0 = performance.now();
	const oldTeardown = cleanupIsolation(old).then(() => performance.now() - t0);
	const successor = await ensureIsolation(r, "reused");
	const tSucc = performance.now() - t0;
	const tOld = await oldTeardown;
	console.log(`successor materialised at ${tSucc.toFixed(0)}ms, old teardown finished at ${tOld.toFixed(0)}ms`);
	const nested = path.join(successor.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "live descendant\n");
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(successor);
	const survived = await Bun.file(data).exists();
	console.log(`descendant holds lease; owner teardown ran; descendant file survived=${survived}`);
	release();
	expect(survived).toBe(true);
}, 60_000);

it("S2: ensureIsolation fails outright when the sandbox lock is held >5s", async () => {
	rcopy();
	const r = await repo();
	const wt = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	setWorktreesDir(wt);
	const first = await ensureIsolation(r, "contended");
	const baseDir = path.dirname(first.mergedDir);
	// Another process holds the sandbox lock (e.g. its own materialisation doing a long clone).
	const holder = Bun.spawn(
		[
			"bun",
			"-e",
			`const { acquireFileLock } = await import("/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils"); const l = await acquireFileLock(${JSON.stringify(baseDir)}); console.log("held"); await Bun.sleep(8000); l.release();`,
		],
		{ stdout: "pipe", stderr: "inherit" },
	);
	const reader = holder.stdout.getReader();
	await reader.read();
	const t0 = performance.now();
	let outcome: string;
	try {
		await cleanupIsolation(first);
		outcome = "cleanup ok";
	} catch (e) {
		outcome = `cleanup threw: ${(e as Error).message}`;
	}
	console.log(`after ${(performance.now() - t0).toFixed(0)}ms: ${outcome}; baseDir exists=${await fs.exists(baseDir)}`);
	holder.kill();
	await scheduler.wait(10);
}, 30_000);
