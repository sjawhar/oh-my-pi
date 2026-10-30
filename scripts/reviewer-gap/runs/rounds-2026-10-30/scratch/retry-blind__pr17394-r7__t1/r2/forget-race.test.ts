import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease.ts";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree.ts";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

const SCRATCH = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/retry-blind__pr17394-r7__t1/r2";

async function git(cwd: string, args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("predecessor teardown forgets successor's lease registration", async () => {
	const root = await fs.mkdtemp(path.join(SCRATCH, "fr-"));
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await git(repo, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, ["add", "."]);
	await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
	const wtBase = path.join(root, "wt");
	await fs.mkdir(wtBase);
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtBase);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});

	const h1 = await ensureIsolation(repo, "same-id");
	const origStop = natives.isoStop;
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let calls = 0;
	vi.spyOn(natives, "isoStop").mockImplementation(async (...args: Parameters<typeof origStop>) => {
		calls += 1;
		if (calls === 1) {
			console.log("isoStop#1 path:", args[1]);
			entered.resolve();
			await gate.promise; // predecessor is mid-teardown of its retired copy
		}
		return await origStop(...args);
	});

	const c1 = cleanupIsolation(h1);
	await entered.promise;
	const h2 = await ensureIsolation(repo, "same-id");
	console.log("successor materialised:", h2.mergedDir === h1.mergedDir, h2.generation !== h1.generation);
	gate.resolve();
	await c1;

	const nested = path.join(h2.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "descendant work\n");
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(h2);
	const survived = await Bun.file(data).exists();
	console.log("descendant file survives owner teardown while leased:", survived);
	release();
	expect(survived).toBe(true);
}, 30_000);

async function setup(tag: string) {
	const root = await fs.mkdtemp(path.join(SCRATCH, `${tag}-`));
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await git(repo, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, ["add", "."]);
	await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
	const wtBase = path.join(root, "wt");
	await fs.mkdir(wtBase);
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

it("control: sequential predecessor teardown then successor keeps lease", async () => {
	const repo = await setup("ctl");
	const h1 = await ensureIsolation(repo, "same-id");
	await cleanupIsolation(h1);
	const h2 = await ensureIsolation(repo, "same-id");
	const nested = path.join(h2.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "x\n");
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(h2);
	const survived = await Bun.file(data).exists();
	console.log("control survives:", survived);
	release();
	expect(survived).toBe(true);
}, 30_000);

it("same-id materialisation waits >5s for the sandbox lock", async () => {
	const repo = await setup("lk");
	const origStart = natives.isoStart;
	let n = 0;
	vi.spyOn(natives, "isoStart").mockImplementation(async (...args: Parameters<typeof origStart>) => {
		n += 1;
		if (n === 1) await Bun.sleep(6000); // a clone that takes 6s
		return await origStart(...args);
	});
	const first = ensureIsolation(repo, "same-id");
	await Bun.sleep(200);
	const t0 = Date.now();
	const second = await ensureIsolation(repo, "same-id").then(
		h => `ok ${h.generation}`,
		e => `rejected after ${Date.now() - t0}ms: ${(e as Error).message}`,
	);
	console.log("second ensureIsolation:", second);
	const h1 = await first;
	console.log("first ensureIsolation ok:", h1.generation);
}, 30_000);
