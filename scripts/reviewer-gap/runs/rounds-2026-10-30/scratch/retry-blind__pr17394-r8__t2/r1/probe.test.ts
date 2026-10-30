import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24";
const { clearWorktrees } = await import(`${H}/packages/coding-agent/src/cli/worktree-cli.ts`);
const { deferTeardownWhileLeased, forgetIsolationWorkspace, leaseIsolationWorkspace, registerIsolationWorkspace } =
	await import(`${H}/packages/coding-agent/src/task/isolation-lease.ts`);
const { ISOLATION_OWNER_FILE, writeIsolationOwner } = await import(
	`${H}/packages/coding-agent/src/task/isolation-ownership.ts`
);
const { cleanupIsolation, ensureIsolation } = await import(`${H}/packages/coding-agent/src/task/worktree.ts`);
const natives = await import(`${H}/node_modules/@oh-my-pi/pi-natives`);
const { acquireFileLock, setWorktreesDir } = await import(`${H}/node_modules/@oh-my-pi/pi-utils`);

const SCRATCH = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/retry-blind__pr17394-r8__t2/r1";

async function git(cwd: string, ...args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

async function setup(alias = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-"));
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "a@b");
	await git(repo, "config", "user.name", "a");
	await fs.writeFile(path.join(repo, "f.txt"), "x\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "init");
	const real = path.join(root, "wt-real");
	await fs.mkdir(real);
	let wtDir = real;
	if (alias) {
		wtDir = path.join(root, "wt-alias");
		await fs.symlink(real, wtDir);
	}
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtDir);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	return { root, repo, wtDir };
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("P1 cross-process lease: owner teardown never runs after the holder releases", async () => {
	const { repo } = await setup();
	const handle = await ensureIsolation(repo, "xproc");
	await fs.writeFile(path.join(handle.mergedDir, "work.txt"), "uncaptured\n");
	const holder = Bun.spawn(["bun", path.join(SCRATCH, "holder.ts"), handle.mergedDir], {
		stdin: "pipe",
		stdout: "pipe",
	});
	const reader = holder.stdout.getReader();
	const dec = new TextDecoder();
	let out = "";
	while (!out.includes("LEASED")) out += dec.decode((await reader.read()).value);
	await cleanupIsolation(handle);
	console.log("after cleanupIsolation, sandbox exists:", await Bun.file(path.join(handle.mergedDir, "work.txt")).exists());
	holder.stdin.write("go\n");
	holder.stdin.flush();
	while (!out.includes("RELEASED")) out += dec.decode((await reader.read()).value);
	await holder.exited;
	await scheduler.wait(500);
	const leases = await fs.readdir(path.join(path.dirname(handle.mergedDir), ".omp-isolation-leases")).catch(e => String(e));
	console.log("holder released + exited; leases left:", JSON.stringify(leases));
	console.log("500ms later, sandbox exists:", await Bun.file(path.join(handle.mergedDir, "work.txt")).exists());
});

it("P2 lease taken after the teardown's lease check is deleted under its holder", async () => {
	const { repo } = await setup();
	const handle = await ensureIsolation(repo, "window");
	const realRename = fs.rename;
	let holderRelease: (() => Promise<void>) | undefined;
	const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to).includes(".retiring-") && !holderRelease) {
			// A session opens in the sandbox after cleanupIsolation's lease check, before its rename.
			holderRelease = await leaseIsolationWorkspace(path.join(handle.mergedDir));
			await fs.writeFile(path.join(handle.mergedDir, "session.txt"), "live session data\n");
			console.log("lease taken inside the window; lease files:", await fs.readdir(path.join(path.dirname(handle.mergedDir), ".omp-isolation-leases")));
		}
		return realRename(from as string, to as string);
	});
	await cleanupIsolation(handle);
	console.log("rename spy calls:", spy.mock.calls.length);
	console.log("lease holder's file exists after cleanup:", await Bun.file(path.join(handle.mergedDir, "session.txt")).exists());
	console.log("mergedDir exists:", await fs.stat(handle.mergedDir).then(() => true, () => false));
	await holderRelease?.();
});

it("P3 defer racing the last lease release loses the teardown", async () => {
	let lost = 0;
	const N = 40;
	for (let i = 0; i < N; i++) {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "race-"));
		const mergedDir = path.join(baseDir, "m");
		await fs.mkdir(mergedDir);
		await writeIsolationOwner(baseDir, "race");
		registerIsolationWorkspace(mergedDir);
		const user = await leaseIsolationWorkspace(mergedDir);
		let torndown = 0;
		const [deferred] = await Promise.all([
			deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1)),
			(async () => {
				await scheduler.wait(i % 4);
				await user();
			})(),
		]);
		await scheduler.wait(20);
		const leases = await fs.readdir(path.join(baseDir, ".omp-isolation-leases"));
		if (deferred && torndown === 0 && leases.length === 0) lost += 1;
		forgetIsolationWorkspace(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
	console.log(`deferred teardown lost (deferred=true, no leases left, teardown never ran): ${lost}/${N}`);
});

it("P4 clear's lock on a symlinked worktrees dir does not exclude ensureIsolation's lock", async () => {
	const { root, wtDir } = await setup(true);
	// A crashed run's leftover (dead owner) at an id about to be re-materialised.
	const name = "t-deadbeef";
	const aliasBase = path.join(wtDir, name);
	await fs.mkdir(path.join(aliasBase, "m"), { recursive: true });
	await Bun.write(path.join(aliasBase, ISOLATION_OWNER_FILE), JSON.stringify({ pid: 999999, id: "x", generation: "g" }));
	const realBase = await fs.realpath(aliasBase);
	// ensureIsolation / cleanupIsolation lock on the resolved identity:
	const held = await acquireFileLock(realBase, { retries: 1, retryDelayMs: 1 });
	const t0 = Date.now();
	const r = await clearWorktrees({ json: true } as never);
	console.log("realBase:", realBase, "clear target:", aliasBase);
	console.log(`clear while ensure-side lock held: ${JSON.stringify(r)} in ${Date.now() - t0}ms; dir exists: ${await fs.stat(realBase).then(() => true, () => false)}`);
	held.release();
	await fs.rm(root, { recursive: true, force: true });
});
