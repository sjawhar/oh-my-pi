import { it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { hasLiveIsolationLease, leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";

async function setup() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "probe-remat-")));
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await $`git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init`.cwd(repo);
	await Bun.write(path.join(repo, "a.txt"), "a\n");
	await $`git add a.txt && git -c user.email=a@b -c user.name=a commit -q -m a`.cwd(repo);
	const wtBase = path.join(root, "wt");
	await fs.mkdir(wtBase);
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(wtBase);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);
	return { root, repo };
}

it("H1: re-materialising an id wipes a leased workspace", async () => {
	const { repo } = await setup();
	const first = await ensureIsolation(repo, "dup");
	const nested = path.join(first.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "written by a descendant\n");
	const release = await leaseIsolationWorkspace(nested);
	console.log("H1 lease live before:", await hasLiveIsolationLease(path.dirname(first.mergedDir)));
	const second = await ensureIsolation(repo, "dup");
	console.log("H1 same path:", second.mergedDir === first.mergedDir);
	console.log("H1 descendant data survives re-materialisation:", await Bun.file(data).exists());
	console.log("H1 lease live after:", await hasLiveIsolationLease(path.dirname(first.mergedDir)));
	await release();
	await cleanupIsolation(second);
});

it("H2: stale teardown's forget drops the successor's registration; successor's lease-deferred teardown never runs", async () => {
	const { repo } = await setup();
	const first = await ensureIsolation(repo, "dup2");
	const second = await ensureIsolation(repo, "dup2");
	// Stale handle torn down (generation mismatch -> skipped). Then the
	// successor gets a nested child and is torn down.
	await cleanupIsolation(first);
	const marker = path.join(second.mergedDir, "succ.txt");
	await fs.writeFile(marker, "successor\n");
	const release = await leaseIsolationWorkspace(second.mergedDir);
	await cleanupIsolation(second);
	console.log("H2 successor kept while leased:", await Bun.file(marker).exists());
	await release();
	await Bun.sleep(100);
	console.log("H2 successor removed after last lease ended:", !(await Bun.file(marker).exists()));
	console.log("H2 lease live:", await hasLiveIsolationLease(path.dirname(second.mergedDir)));
});
