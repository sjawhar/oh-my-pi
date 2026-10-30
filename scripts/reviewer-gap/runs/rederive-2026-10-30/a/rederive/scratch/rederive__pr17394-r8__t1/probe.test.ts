import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages";
const { clearWorktrees } = await import(`${H}/coding-agent/src/cli/worktree-cli.ts`);
const { deferTeardownWhileLeased, hasLiveIsolationLease, leaseIsolationWorkspace } = await import(
	`${H}/coding-agent/src/task/isolation-lease.ts`
);
const { ISOLATION_OWNER_FILE } = await import(`${H}/coding-agent/src/task/isolation-ownership.ts`);
const { cleanupIsolation, ensureIsolation } = await import(`${H}/coding-agent/src/task/worktree.ts`);
const natives = await import(`${H}/natives/native/index.js`);
const { removeWithRetries, setWorktreesDir, tryAcquireFileLock } = await import(`${H}/utils/src/index.ts`);

const temps: string[] = [];
async function tmp(prefix: string) {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temps.push(d);
	return d;
}
async function git(cwd: string, args: string[]) {
	const p = Bun.spawnSync(["git", ...args], { cwd });
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}
async function repo() {
	const r = await tmp("probe-repo-");
	await git(r, ["init", "-q", "-b", "main"]);
	await git(r, ["config", "user.email", "a@b"]);
	await git(r, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["commit", "-qm", "init"]);
	return r;
}
function rcopy() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
}
afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	await Promise.all(temps.splice(0).map(d => removeWithRetries(d)));
});

describe("probes", () => {
	it("P1: lease taken after the teardown's lease check but before its rename is lost", async () => {
		const r = await repo();
		rcopy();
		setWorktreesDir(await tmp("probe-wt-"));
		const handle = await ensureIsolation(r, "p1");
		const nested = path.join(handle.mergedDir, "nested");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(path.join(nested, "work.txt"), "descendant work\n");

		let descendantRelease: (() => Promise<void>) | undefined;
		const realRename = fs.rename;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).includes(".retiring-") && !descendantRelease) {
				// A nested child spawns from the parent's cwd at this instant.
				descendantRelease = await leaseIsolationWorkspace(nested);
				console.log("P1 lease taken; hasLiveIsolationLease =", await hasLiveIsolationLease(path.dirname(handle.mergedDir)));
			}
			return realRename(from as string, to as string);
		});
		await cleanupIsolation(handle);
		console.log("P1 descendant lease obtained:", descendantRelease !== undefined);
		console.log("P1 descendant work.txt exists after teardown:", await Bun.file(path.join(nested, "work.txt")).exists());
		const base = path.dirname(handle.mergedDir);
		console.log("P1 base dir entries after teardown:", await fs.readdir(base).catch(e => `ERR ${e.code}`));
		console.log("P1 owner marker at base:", await Bun.file(path.join(base, ISOLATION_OWNER_FILE)).exists());
		await descendantRelease?.();
	});

	it("P2: clear locks the unresolved path, materialisation locks the realpath", async () => {
		const r = await repo();
		rcopy();
		const real = await tmp("probe-wtreal-");
		const linkParent = await tmp("probe-wtlink-");
		const link = path.join(linkParent, "wt");
		await fs.symlink(real, link);
		setWorktreesDir(link);
		const first = await ensureIsolation(r, "p2");
		console.log("P2 handle.mergedDir:", first.mergedDir);

		// Second materialisation of the same id, held mid-build inside its lock.
		const gate = Promise.withResolvers<void>();
		const inStart = Promise.withResolvers<void>();
		const isoStart = natives.isoStart;
		vi.spyOn(natives, "isoStart").mockImplementation(async (...args) => {
			inStart.resolve();
			await gate.promise;
			return await isoStart(...args);
		});
		const building = ensureIsolation(r, "p2");
		await inStart.promise;
		const base = path.dirname(first.mergedDir);
		console.log("P2 realpath lock free while materialising?", tryAcquireFileLock(base) !== null);
		const t0 = Date.now();
		const res = await clearWorktrees({ all: true, dryRun: false, json: true });
		console.log("P2 clear --all returned in ms:", Date.now() - t0, res);
		console.log("P2 marker exists after clear (materialisation still in its lock):", await Bun.file(path.join(base, ISOLATION_OWNER_FILE)).exists());
		gate.resolve();
		const built = await building.then(
			h => h,
			e => {
				console.log("P2 materialisation ERR", String(e));
				return undefined;
			},
		);
		console.log("P2 materialisation result:", built ? `ok ${built.mergedDir}` : "failed");
		console.log("P2 marker after materialisation:", await Bun.file(path.join(base, ISOLATION_OWNER_FILE)).exists());
		if (built) {
			await cleanupIsolation(built);
			console.log("P2 sandbox still on disk after its own owner's cleanupIsolation:", await Bun.file(path.join(built.mergedDir, "f.txt")).exists());
		}
	});

	it("P3: deferred teardown of run A fires against run B's workspace (same id, same process)", async () => {
		const r = await repo();
		rcopy();
		setWorktreesDir(await tmp("probe-wt3-"));
		const a = await ensureIsolation(r, "p3");
		const descendantOfA = await leaseIsolationWorkspace(path.join(a.mergedDir));
		let ranA = 0;
		let sawGeneration = "";
		const deferred = await deferTeardownWhileLeased(a.mergedDir, async () => {
			ranA += 1;
			const marker = await Bun.file(path.join(path.dirname(a.mergedDir), ISOLATION_OWNER_FILE)).json();
			sawGeneration = marker.generation;
			// isolation-runner's captureAndCleanup would writeIsolationPatch(a.mergedDir, ...) here
			console.log("P3 A's deferred teardown sees tree:", await fs.readdir(a.mergedDir));
		});
		console.log("P3 A deferred:", deferred, "A.gen:", a.generation);
		// Replacement spawn of the same id.
		const b = await ensureIsolation(r, "p3");
		await fs.writeFile(path.join(b.mergedDir, "B-in-progress.txt"), "B\n");
		console.log("P3 B.gen:", b.generation, "same path:", a.mergedDir === b.mergedDir);
		await descendantOfA();
		await scheduler.wait(20);
		console.log("P3 A's teardown ran:", ranA, "marker generation at that time:", sawGeneration, "is B:", sawGeneration === b.generation);
		await cleanupIsolation(b);
	});
});

describe("probes2", () => {
	it("P4: lease held by another process: owner's deferred teardown never runs after it ends", async () => {
		const r = await repo();
		rcopy();
		setWorktreesDir(await tmp("probe-wt4-"));
		const h = await ensureIsolation(r, "p4");
		const script = `const m = await import("${H}/coding-agent/src/task/isolation-lease.ts");
const rel = await m.leaseIsolationWorkspace(${JSON.stringify(h.mergedDir)});
console.log("child leased");
await Bun.sleep(500);
await rel();
console.log("child released");`;
		const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
		await scheduler.wait(300);
		await cleanupIsolation(h);
		console.log("P4 after owner cleanup, sandbox exists:", await Bun.file(path.join(h.mergedDir, "f.txt")).exists());
		await child.exited;
		console.log("P4 child:", (await new Response(child.stdout).text()).trim().replace(/\n/g, " | "), (await new Response(child.stderr).text()).trim());
		await scheduler.wait(2000);
		console.log("P4 2s after the only lease ended, sandbox exists:", await Bun.file(path.join(h.mergedDir, "f.txt")).exists());
		console.log("P4 live lease:", await hasLiveIsolationLease(path.dirname(h.mergedDir)));
	});
});
