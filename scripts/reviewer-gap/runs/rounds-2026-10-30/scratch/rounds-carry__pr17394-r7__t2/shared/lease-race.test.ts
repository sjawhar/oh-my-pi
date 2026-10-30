import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scratch = fs.mkdtempSync(path.join("/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r7__t2/shared", "lr-"));
process.env.OMP_WORKTREE_DIR = path.join(scratch, "wt");

const NATIVES = Bun.resolveSync("@oh-my-pi/pi-natives", "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task");
const real = await import(NATIVES);
let gate: PromiseWithResolvers<void> | undefined;
let stopEntered: PromiseWithResolvers<void> | undefined;
mock.module(NATIVES, () => ({
	...real,
	isoStop: async (kind: unknown, merged: string) => {
		if (gate) {
			stopEntered?.resolve();
			await gate.promise; // a slow backend stop (large tree removal)
		}
		return real.isoStop(kind as never, merged);
	},
}));

const { ensureIsolation, cleanupIsolation } = await import(
	"/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree.ts"
);
const { leaseIsolationWorkspace } = await import(
	"/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease.ts"
);

function makeRepo(): string {
	const repo = path.join(scratch, "repo");
	fs.mkdirSync(repo, { recursive: true });
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
	Bun.spawnSync(["git", "add", "."], { cwd: repo });
	Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: repo });
	return repo;
}

test("control: a leased sandbox defers teardown", async () => {
	const repo = makeRepo();
	const h = await ensureIsolation(repo, "ctl");
	const release = leaseIsolationWorkspace(h.mergedDir);
	await cleanupIsolation(h);
	console.log("control: merged exists while leased =", fs.existsSync(h.mergedDir));
	release();
	await Bun.sleep(300);
	console.log("control: merged exists after release =", fs.existsSync(h.mergedDir));
});

test("old teardown's forget drops the successor's registration", async () => {
	const repo = makeRepo();
	const h1 = await ensureIsolation(repo, "same-id");
	gate = Promise.withResolvers();
	stopEntered = Promise.withResolvers();
	const oldCleanup = cleanupIsolation(h1); // gen1 teardown: renames, releases lock, then slow isoStop
	await stopEntered.promise;
	const h2Promise = ensureIsolation(repo, "same-id"); // replacement spawn, same id
	// ensureIsolation must not hit the gated stop
	const h2 = await h2Promise;
	console.log("gen1", h1.generation, "gen2", h2.generation);
	gate.resolve();
	gate = undefined;
	await oldCleanup;
	fs.writeFileSync(path.join(h2.mergedDir, "nested-child-work.txt"), "in-flight\n");
	// A nested child inherits gen2's cwd and takes a lease.
	const release = leaseIsolationWorkspace(path.join(h2.mergedDir));
	// gen2's owner ends while the nested child is still working.
	await cleanupIsolation(h2);
	console.log("race: merged exists while nested child holds lease =", fs.existsSync(h2.mergedDir));
	release();
});
