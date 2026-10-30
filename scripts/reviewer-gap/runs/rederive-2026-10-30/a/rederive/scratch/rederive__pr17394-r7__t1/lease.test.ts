import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-coding-agent/src/task/worktree";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-coding-agent/src/task/isolation-lease";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { acquireFileLock, setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

async function setup(tag: string) {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-repo-`));
	await git(repo, ["init", "-q", "-b", "main"]);
	await git(repo, ["config", "user.email", "a@b"]);
	await git(repo, ["config", "user.name", "a"]);
	await fs.writeFile(path.join(repo, "f.txt"), "x\n");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-q", "-m", "init"]);
	const wtBase = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-wt-`));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtBase);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	return repo;
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("A: gen-1 teardown forgets the lease entry gen-2 shares by path", async () => {
	const repo = await setup("a");
	const h1 = await ensureIsolation(repo, "reused-id");

	// Hold gen-1's teardown after it renamed the dir and released the lock.
	const gate = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	const realStop = natives.isoStop;
	vi.spyOn(natives, "isoStop").mockImplementation(async (...args) => {
		reached.resolve();
		await gate.promise;
		return await realStop(...args);
	});
	const c1 = cleanupIsolation(h1);
	await reached.promise;

	// Replacement spawn for the same id materialises the same path.
	const h2 = await ensureIsolation(repo, "reused-id");
	console.log("same mergedDir:", h1.mergedDir === h2.mergedDir, "gen differ:", h1.generation !== h2.generation);
	const nested = path.join(h2.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "live descendant data\n");
	// A nested child of gen-2 leases the workspace.
	const lease = leaseIsolationWorkspace(nested);

	// gen-1's teardown finishes: forgetIsolationWorkspace(h1.mergedDir).
	gate.resolve();
	await c1;

	// gen-2's owner tears down while the descendant still holds its lease.
	await cleanupIsolation(h2);
	console.log("descendant data exists after gen-2 teardown while leased:", await Bun.file(data).exists());
	lease();
});

it("B: lease taken while teardown waits on the lock is ignored", async () => {
	const repo = await setup("b");
	const h = await ensureIsolation(repo, "lock-wait");
	const nested = path.join(h.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "live descendant data\n");

	// Something else (another materialisation/teardown of this id) holds the sandbox lock.
	const other = await acquireFileLock(path.dirname(h.mergedDir));
	const c = cleanupIsolation(h); // checks leases now (none), then awaits the lock
	await Bun.sleep(50);
	const lease = leaseIsolationWorkspace(nested); // descendant starts working here
	other.release();
	await c;
	console.log("descendant data exists after teardown while leased:", await Bun.file(data).exists());
	lease();
});
