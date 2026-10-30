import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
const SRC = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const natives = await import(Bun.resolveSync("@oh-my-pi/pi-natives", SRC));
const { acquireFileLock, setWorktreesDir } = await import(Bun.resolveSync("@oh-my-pi/pi-utils", SRC));

console.log("natives resolved", Bun.resolveSync("@oh-my-pi/pi-natives", SRC));
const { ensureIsolation, cleanupIsolation, resolveSandboxIdentity } = await import(`${SRC}/task/worktree.ts`);
const { hasLiveIsolationLease, ISOLATION_LEASE_DIR } = await import(`${SRC}/task/isolation-lease.ts`);
const { decideIsolationReclaim, ISOLATION_OWNER_FILE } = await import(`${SRC}/task/isolation-ownership.ts`);
const { clearWorktrees } = await import(`${SRC}/cli/worktree-cli.ts`);
const HOLDER = path.join(import.meta.dir, "lease-holder.ts");

const cleanup: string[] = [];
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const d of cleanup.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	cleanup.push(repo);
	await Bun.$`git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init && echo hi > f.txt && git add f.txt && git -c user.email=a@b -c user.name=a commit -q -m f`.cwd(repo);
	return repo;
}

async function deadPid(): Promise<number> {
	const p = Bun.spawn(["true"]);
	await p.exited;
	return p.pid;
}

describe("probes", () => {
	for (const mode of ["release", "sigkill"] as const) {
		it(`cross-process lease (${mode}): owner's deferred teardown never runs`, async () => {
			const repo = await makeRepo();
			vi.spyOn(natives, "isoResolve").mockResolvedValue({
				kind: natives.IsoBackendKind.Rcopy,
				candidates: [natives.IsoBackendKind.Rcopy],
				fellBack: false,
				reason: undefined,
			});
			const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
			cleanup.push(wtRoot);
			delete process.env.OMP_WORKTREE_DIR;
			setWorktreesDir(wtRoot);
			const handle = await ensureIsolation(repo, `xproc-${mode}`);
			const data = path.join(handle.mergedDir, "child-work.txt");
			await fs.writeFile(data, "work\n");

			const child = Bun.spawn(["bun", HOLDER, handle.mergedDir, mode === "release" ? "release" : "hold"], {
				stdin: "pipe",
				stdout: "pipe",
			});
			const reader = child.stdout.getReader();
			const first = new TextDecoder().decode((await reader.read()).value);
			console.log(`[${mode}] child says:`, first.trim());

			await cleanupIsolation(handle);
			console.log(`[${mode}] after cleanupIsolation while leased: data exists =`, await Bun.file(data).exists());

			if (mode === "release") {
				child.stdin.write("go\n");
				await child.stdin.flush();
			} else {
				child.kill("SIGKILL");
			}
			console.log(`[${mode}] child exit =`, await child.exited, "signal =", child.signalCode);
			await scheduler.wait(2000);
			const baseDir = path.dirname(handle.mergedDir);
			console.log(`[${mode}] 2s after holder gone: hasLiveIsolationLease =`, await hasLiveIsolationLease(baseDir));
			console.log(`[${mode}] 2s after holder gone: data exists =`, await Bun.file(data).exists());
			console.log(`[${mode}] decideIsolationReclaim =`, JSON.stringify(await decideIsolationReclaim(baseDir)));
			expect(await Bun.file(data).exists()).toBe(false); // what the deferral promises
		}, 30_000);
	}

	it("re-materialising an id wipes a sandbox a live lease still works in", async () => {
		const repo = await makeRepo();
		vi.spyOn(natives, "isoResolve").mockResolvedValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
		cleanup.push(wtRoot);
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(wtRoot);
		const { leaseIsolationWorkspace } = await import(`${SRC}/task/isolation-lease.ts`);
		const first = await ensureIsolation(repo, "reused-id");
		const nested = path.join(first.mergedDir, "nested");
		await fs.mkdir(nested, { recursive: true });
		const data = path.join(nested, "descendant.txt");
		await fs.writeFile(data, "uncaptured work\n");
		const lease = await leaseIsolationWorkspace(nested);
		console.log("lease live before second ensureIsolation =", await hasLiveIsolationLease(path.dirname(first.mergedDir)));
		const second = await ensureIsolation(repo, "reused-id");
		console.log("same mergedDir =", second.mergedDir === first.mergedDir);
		console.log("descendant's file after second ensureIsolation =", await Bun.file(data).exists());
		console.log("lease live after =", await hasLiveIsolationLease(path.dirname(first.mergedDir)));
		await lease();
	}, 30_000);

	it("worktree clear's lock does not exclude ensureIsolation's lock when the worktrees root is a symlink", async () => {
		const real = await fs.mkdtemp(path.join(os.tmpdir(), "probe-real-"));
		cleanup.push(real);
		const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "probe-link-"));
		cleanup.push(linkParent);
		const link = path.join(linkParent, "wt");
		await fs.symlink(real, link);
		const base = path.join(real, "t-sandbox");
		await fs.mkdir(path.join(base, "m"), { recursive: true });
		await Bun.write(
			path.join(base, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "x", generation: "dead-gen" }),
		);
		// What ensureIsolation holds for the whole materialisation:
		const identity = await resolveSandboxIdentity(path.join(link, "t-sandbox"));
		console.log("ensureIsolation lock identity =", identity);
		const held = await acquireFileLock(identity);
		try {
			setWorktreesDir(link);
			const t0 = Date.now();
			const result = await clearWorktrees({ json: true } as never);
			console.log("clear (root via symlink) while sandbox lock held:", JSON.stringify(result), `in ${Date.now() - t0}ms`);
			console.log("sandbox exists after clear =", await Bun.file(path.join(base, ISOLATION_OWNER_FILE)).exists());
		} finally {
			held.release();
		}
		// Control: same thing with the canonical root.
		await fs.mkdir(path.join(base, "m"), { recursive: true });
		await Bun.write(
			path.join(base, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "x", generation: "dead-gen" }),
		);
		const held2 = await acquireFileLock(identity);
		try {
			setWorktreesDir(real);
			const t0 = Date.now();
			const result = await clearWorktrees({ json: true } as never);
			console.log("clear (canonical root) while sandbox lock held:", JSON.stringify(result), `in ${Date.now() - t0}ms`);
		} finally {
			held2.release();
		}
	}, 30_000);

	it("an empty lease file (holder killed between create and write) pins a dead sandbox for ever", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-empty-"));
		cleanup.push(base);
		await fs.mkdir(path.join(base, "m"));
		await Bun.write(path.join(base, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "x", generation: "g" }));
		await fs.mkdir(path.join(base, ISOLATION_LEASE_DIR));
		await Bun.write(path.join(base, ISOLATION_LEASE_DIR, "123-456.json.123.789.tmp"), "");
		console.log("hasLiveIsolationLease =", await hasLiveIsolationLease(base));
		console.log("decideIsolationReclaim =", JSON.stringify(await decideIsolationReclaim(base)));
		console.log("lease dir after =", await fs.readdir(path.join(base, ISOLATION_LEASE_DIR)));
	});
});
