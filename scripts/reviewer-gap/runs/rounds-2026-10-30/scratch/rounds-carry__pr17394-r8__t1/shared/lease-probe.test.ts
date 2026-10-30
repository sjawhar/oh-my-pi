import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	decideIsolationReclaim,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, resolveSandboxIdentity } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { acquireFileLock, tryAcquireFileLock } from "@oh-my-pi/pi-utils";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function sandbox() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-")));
	dirs.push(root);
	const baseDir = path.join(root, "t-sandbox");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	const generation = await writeIsolationOwner(baseDir, "probe");
	return { root, baseDir, mergedDir, generation };
}

describe("probe", () => {
	it("A: lease through a symlinked cwd strands the owner's deferred teardown", async () => {
		const { root, baseDir, mergedDir } = await sandbox();
		const alias = path.join(root, "alias");
		await fs.symlink(baseDir, alias);
		registerIsolationWorkspace(mergedDir);
		try {
			const release = await leaseIsolationWorkspace(path.join(alias, "m"));
			let torndown = 0;
			const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1));
			await release();
			console.log("A deferred=", deferred, "torndown after last lease released=", torndown,
				"liveLease=", await hasLiveIsolationLease(baseDir));
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("B: lease held by another process: its release never runs the owner's teardown", async () => {
		const { baseDir, mergedDir } = await sandbox();
		registerIsolationWorkspace(mergedDir);
		try {
			const script = path.join(path.dirname(import.meta.path), "lease-child.ts");
			const child = Bun.spawn(["bun", script, mergedDir], { stdout: "pipe", stderr: "inherit" });
			const reader = child.stdout.getReader();
			const first = new TextDecoder().decode((await reader.read()).value);
			console.log("B child says:", first.trim());
			let torndown = 0;
			const deferred = await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1));
			child.kill("SIGUSR2"); // tell it to release cleanly
			await child.exited;
			await Bun.sleep(200);
			console.log("B deferred=", deferred, "child exit=", child.exitCode, "torndown=", torndown,
				"liveLease=", await hasLiveIsolationLease(baseDir));
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("C: leasing does not take the sandbox lock (lease lands while teardown holds it)", async () => {
		const { baseDir, mergedDir } = await sandbox();
		const lock = await acquireFileLock(await resolveSandboxIdentity(baseDir));
		const t0 = performance.now();
		const release = await leaseIsolationWorkspace(mergedDir);
		console.log("C lease acquired while lock held, ms=", (performance.now() - t0).toFixed(1),
			"lease files=", await fs.readdir(path.join(baseDir, ISOLATION_LEASE_DIR)));
		lock.release();
		await release();
	});

	it("D: lease taken between cleanupIsolation's lease check and its rename -> sandbox deleted under it", async () => {
		const { baseDir, mergedDir, generation } = await sandbox();
		await Bun.write(path.join(mergedDir, "work.txt"), "user data");
		registerIsolationWorkspace(mergedDir);
		const realRename = fs.rename;
		let userRelease: (() => Promise<void>) | undefined;
		// fs is the node:fs/promises namespace worktree.ts imports
		const spy = (await import("bun:test")).spyOn(fs, "rename").mockImplementation(async (a: any, b: any) => {
			if (a === baseDir && !userRelease) {
				// A session opens in the sandbox at this instant (another process, or a nested child).
				userRelease = await leaseIsolationWorkspace(path.join(mergedDir));
				console.log("D lease taken mid-teardown; live=", await hasLiveIsolationLease(baseDir));
			}
			return realRename(a, b);
		});
		try {
			await cleanupIsolation({
				mergedDir,
				generation,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			});
			console.log("D after cleanup: baseDir exists=", await Bun.file(path.join(mergedDir, "work.txt")).exists(),
				"lease holder still thinks it holds:", typeof userRelease);
		} finally {
			spy.mockRestore();
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("E: clear's lock name vs materialisation's lock name under a symlinked worktrees dir", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-")));
		dirs.push(root);
		const real = path.join(root, "real-worktrees");
		await fs.mkdir(path.join(real, "t-abc"), { recursive: true });
		const link = path.join(root, "linked-worktrees");
		await fs.symlink(real, link);
		const ensureSide = await resolveSandboxIdentity(path.join(link, "t-abc"));
		const held = await acquireFileLock(ensureSide);
		const clearSide = tryAcquireFileLock(path.join(link, "t-abc"));
		console.log("E ensureIsolation locks", ensureSide, "; clear's acquire on", path.join(link, "t-abc"),
			"while held ->", clearSide ? "ACQUIRED (no exclusion)" : "blocked");
		clearSide?.release();
		held.release();
	});

	it("F: one stray unreadable file in the lease dir pins a dead owner's sandbox forever", async () => {
		const { baseDir } = await sandbox();
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		await Bun.write(path.join(baseDir, ".omp-isolation-owner.json"), JSON.stringify({ pid: dead.pid, id: "x", generation: "g" }));
		console.log("F before stray:", await decideIsolationReclaim(baseDir));
		// what a writer SIGKILLed inside writeFileAtomically leaves: an empty temp file
		await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, `123-1.json.123.1.tmp`), "");
		console.log("F after stray:", await decideIsolationReclaim(baseDir));
	});
});
