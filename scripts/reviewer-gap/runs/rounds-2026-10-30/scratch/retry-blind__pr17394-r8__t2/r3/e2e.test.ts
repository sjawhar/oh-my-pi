import { it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
const SRC = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const natives = await import(Bun.resolveSync("@oh-my-pi/pi-natives", SRC));
const { setWorktreesDir } = await import(Bun.resolveSync("@oh-my-pi/pi-utils", SRC));
const { ensureIsolation, cleanupIsolation } = await import(`${SRC}/task/worktree`);
const { decideIsolationReclaim } = await import(`${SRC}/task/isolation-ownership`);

const HOLDER = path.join(import.meta.dir, "holder.ts");

it("owner teardown deferred by another process's session never runs", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await $`git init -q ${repo} && git -C ${repo} -c user.email=a@b -c user.name=a commit -q --allow-empty -m init`.quiet();
	await Bun.write(path.join(repo, "f.txt"), "x\n");
	await $`git -C ${repo} add . && git -C ${repo} -c user.email=a@b -c user.name=a commit -q -m f`.quiet();
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	const wtBase = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtBase);
	const handle = await ensureIsolation(repo, "xproc-id");
	const baseDir = path.dirname(handle.mergedDir);
	const child = Bun.spawn(["bun", HOLDER, handle.mergedDir, "release"], { stdout: "pipe", stderr: "inherit" });
	const reader = child.stdout.getReader();
	let out = "";
	while (!out.includes("LEASED")) out += new TextDecoder().decode((await reader.read()).value);
	await cleanupIsolation(handle);
	console.log("after cleanupIsolation (session in other process live): exists =", await Bun.file(path.join(handle.mergedDir, "f.txt")).exists());
	await child.exited;
	await Bun.sleep(3000);
	console.log("other process released lease and exited:", child.exitCode);
	console.log("3s later: sandbox exists =", await Bun.file(path.join(handle.mergedDir, "f.txt")).exists());
	console.log("omp worktree clear decision:", JSON.stringify(await decideIsolationReclaim(baseDir)));
	setWorktreesDir(undefined);
	await fs.rm(wtBase, { recursive: true, force: true });
	await fs.rm(repo, { recursive: true, force: true });
}, 30_000);
