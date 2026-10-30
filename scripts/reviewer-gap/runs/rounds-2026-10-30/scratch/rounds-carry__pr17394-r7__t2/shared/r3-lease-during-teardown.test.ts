import { mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SHARED = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r7__t2/shared";
const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task";
const scratch = fs.mkdtempSync(path.join(SHARED, "r3l-"));
process.env.OMP_WORKTREE_DIR = path.join(scratch, "wt");

const NATIVES = Bun.resolveSync("@oh-my-pi/pi-natives", HEAD);
const real = await import(NATIVES);
let gate: PromiseWithResolvers<void> | undefined;
let stopEntered: PromiseWithResolvers<void> | undefined;
mock.module(NATIVES, () => ({
	...real,
	isoStop: async (kind: unknown, merged: string) => {
		if (gate) {
			stopEntered?.resolve();
			await gate.promise; // slow backend stop / large tree removal
		}
		return real.isoStop(kind as never, merged);
	},
}));

const { ensureIsolation, cleanupIsolation } = await import(`${HEAD}/worktree.ts`);
const { leaseIsolationWorkspace } = await import(`${HEAD}/isolation-lease.ts`);

function makeRepo(name: string): string {
	const repo = path.join(scratch, name);
	fs.mkdirSync(repo, { recursive: true });
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
	Bun.spawnSync(["git", "add", "."], { cwd: repo });
	Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: repo });
	return repo;
}

test("A: lease taken while the owner's teardown is in flight", async () => {
	const repo = makeRepo("repoA");
	const h = await ensureIsolation(repo, "id-a");
	gate = Promise.withResolvers();
	stopEntered = Promise.withResolvers();
	const teardown = cleanupIsolation(h); // passes deferTeardownWhileLeased (uses=0)
	await stopEntered.promise;
	// A nested child spawned from the sandbox now: runStructuredSubagent -> leaseIsolationWorkspace(cwd)
	const release = leaseIsolationWorkspace(path.join(h.mergedDir, "sub"));
	console.log("A: lease is a real hold (not the no-op) =", release.toString().includes("released"));
	gate.resolve();
	gate = undefined;
	await teardown;
	console.log("A: mergedDir exists while lease held =", fs.existsSync(h.mergedDir));
	release();
});

test("B: lease taken after last lease released, while the deferred teardown runs", async () => {
	const repo = makeRepo("repoB");
	const h = await ensureIsolation(repo, "id-b");
	const first = leaseIsolationWorkspace(h.mergedDir);
	await cleanupIsolation(h); // deferred
	console.log("B: deferred, mergedDir exists =", fs.existsSync(h.mergedDir));
	gate = Promise.withResolvers();
	stopEntered = Promise.withResolvers();
	first(); // last lease ends -> void pending()
	await stopEntered.promise;
	const second = leaseIsolationWorkspace(h.mergedDir); // second nested child spawns
	console.log("B: second lease is a real hold =", second.toString().includes("released"));
	gate.resolve();
	gate = undefined;
	await Bun.sleep(500);
	console.log("B: mergedDir exists while second lease held =", fs.existsSync(h.mergedDir));
	second();
});
