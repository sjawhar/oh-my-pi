import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task";
const natives = require(Bun.resolveSync("@oh-my-pi/pi-natives", H));
const { cleanupIsolation, ensureIsolation } = await import(`${H}/worktree.ts`);
const { deferTeardownWhileLeased, leaseIsolationWorkspace } = await import(`${H}/isolation-lease.ts`);

it("old-generation teardown forgets the successor's lease registration", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-lease-"));
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await $`git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init`.cwd(repo);
	process.env.OMP_WORKTREE_DIR = path.join(root, "wt");
	spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	} as never);

	const a = await ensureIsolation(repo, "same-id");
	// Make A's teardown rm slow so B can materialise while it runs.
	const bulk = path.join(a.mergedDir, "bulk");
	await fs.mkdir(bulk);
	for (let i = 0; i < 20000; i++) fsSync.writeFileSync(path.join(bulk, `f${i}`), "x");
	const baseDir = path.dirname(a.mergedDir);

	const tA = cleanupIsolation(a);
	while (fsSync.existsSync(baseDir)) await Bun.sleep(1); // A has renamed and released the lock
	await tA; const b = await ensureIsolation(repo, "same-id");
	console.log("B materialised; A teardown still running:", fsSync.existsSync(`${baseDir}.retiring-${a.generation}`));
	await tA;

	// A nested child of B now leases B's workspace, then B's owner tears down.
	const release = leaseIsolationWorkspace(path.join(b.mergedDir, "sub"));
	const deferred = deferTeardownWhileLeased(b.mergedDir, async () => {});
	console.log("successor teardown deferred while leased:", deferred);
	await fs.writeFile(path.join(b.mergedDir, "child-work.txt"), "live descendant data");
	await cleanupIsolation(b);
	console.log("descendant data survives B teardown:", fsSync.existsSync(path.join(b.mergedDir, "child-work.txt")));
	release();
	await fs.rm(root, { recursive: true, force: true });
	expect(deferred).toBe(true);
}, 120_000);
