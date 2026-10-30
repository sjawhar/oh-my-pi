import { afterEach, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { hasLiveIsolationLease, leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { decideIsolationReclaim } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

const cleanups: string[] = [];
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const d of cleanups.splice(0)) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function git(cwd: string, ...args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
async function makeRepo(): Promise<string> {
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "probe3-repo-"));
	cleanups.push(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "a@b");
	await git(repo, "config", "user.name", "a");
	await Bun.write(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "init");
	return repo;
}
function rcopy() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}
async function setup() {
	rcopy();
	const repo = await makeRepo();
	const wt = await fsp.mkdtemp(path.join(os.tmpdir(), "probe3-wt-"));
	cleanups.push(wt);
	setWorktreesDir(wt);
	return repo;
}

async function scenario(interleave: boolean) {
	const repo = await setup();
	const id = interleave ? "genA" : "genB";
	const h1 = await ensureIsolation(repo, id);
	let h2: Awaited<ReturnType<typeof ensureIsolation>> | undefined;
	if (interleave) {
		const realRm = fsp.rm;
		const spy = vi.spyOn(fsp, "rm").mockImplementation(async (p: any, o: any) => {
			if (!h2 && String(p).includes(".retiring-")) {
				// Replacement spawn of the same id materialises while the old
				// generation's retired copy is still being removed.
				spy.mockImplementation(realRm as any);
				h2 = await ensureIsolation(repo, id);
			}
			return realRm(p, o);
		});
		await cleanupIsolation(h1);
		spy.mockRestore();
	} else {
		await cleanupIsolation(h1);
		h2 = await ensureIsolation(repo, id);
	}
	if (!h2) throw new Error("no h2");
	const base = path.dirname(h2.mergedDir);
	const nested = path.join(h2.mergedDir, "nested");
	await fsp.mkdir(nested, { recursive: true });
	const release = await leaseIsolationWorkspace(nested);
	await cleanupIsolation(h2); // owner teardown: deferred while leased
	const deferred = await fsp.exists(base);
	await release();
	await scheduler.wait(1500);
	console.error(
		`interleave=${interleave} same-generation=${h1.generation === h2.generation} teardown deferred=${deferred} ` +
			`liveLease=${await hasLiveIsolationLease(base)} h2 sandbox still exists 1.5s after last lease released=${await fsp.exists(base)} ` +
			`clear decision=${JSON.stringify(await decideIsolationReclaim(base))}`,
	);
}

it("stale generation's teardown forgets the live generation's registration", async () => {
	await scenario(false);
	await scenario(true);
}, 60_000);
