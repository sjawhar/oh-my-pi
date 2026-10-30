import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SHARED = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r7__t2/shared";
const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task";
const scratch = fs.mkdtempSync(path.join(SHARED, "r2lt-"));
process.env.OMP_WORKTREE_DIR = path.join(scratch, "wt");

const NATIVES = Bun.resolveSync("@oh-my-pi/pi-natives", HEAD);
const real = await import(NATIVES);
const realIsoStart = real.isoStart;
let startGate: PromiseWithResolvers<void> | undefined;
let startEntered: PromiseWithResolvers<void> | undefined;
let startFail: Error | undefined;
mock.module(NATIVES, () => ({
	...real,
	isoStart: async (kind: unknown, repo: string, merged: string) => {
		if (startFail) throw startFail;
		if (startGate) {
			startEntered?.resolve();
			await startGate.promise; // a large repo copy
		}
		return realIsoStart(kind as never, repo, merged);
	},
}));

const { ensureIsolation, cleanupIsolation } = await import(`${HEAD}/worktree.ts`);
const { hasLiveIsolationOwner } = await import(`${HEAD}/isolation-ownership.ts`);

function makeRepo(name: string): string {
	const repo = path.join(scratch, name);
	fs.mkdirSync(repo, { recursive: true });
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
	Bun.spawnSync(["git", "add", "."], { cwd: repo });
	Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: repo });
	return repo;
}

test("teardown during a >5s materialisation of the same id", async () => {
	const repo = makeRepo("repo1");
	const h1 = await ensureIsolation(repo, "same-id");
	startGate = Promise.withResolvers();
	startEntered = Promise.withResolvers();
	const gen2 = ensureIsolation(repo, "same-id"); // replacement spawn copying a big repo
	await startEntered.promise;
	const t0 = Date.now();
	let outcome: string;
	try {
		await cleanupIsolation(h1);
		outcome = "resolved";
	} catch (e) {
		outcome = `rejected: ${(e as Error).message}`;
	}
	console.log(`cleanupIsolation(h1) after ${Date.now() - t0}ms -> ${outcome}`);
	// A third same-id materialisation while gen2 still copies
	const t1 = Date.now();
	try {
		await ensureIsolation(repo, "same-id");
		console.log("third ensureIsolation resolved");
	} catch (e) {
		console.log(`third ensureIsolation after ${Date.now() - t1}ms -> rejected: ${(e as Error).message}`);
	}
	startGate.resolve();
	startGate = undefined;
	const h2 = await gen2;
	await cleanupIsolation(h2);
}, 30_000);

test("failed non-fallback attempt leaves a claimed, live-owned sandbox behind", async () => {
	const repo = makeRepo("repo2");
	startFail = new Error("simulated copy failure: ENOSPC");
	let err = "";
	try {
		await ensureIsolation(repo, "fail-id");
	} catch (e) {
		err = (e as Error).message;
	}
	startFail = undefined;
	const wt = process.env.OMP_WORKTREE_DIR!;
	const left = fs.readdirSync(wt);
	console.log("ensureIsolation rejected:", err);
	for (const d of left) {
		const base = path.join(wt, d);
		if (!fs.statSync(base).isDirectory() || d.startsWith("r2")) continue;
		const entries = fs.readdirSync(base);
		if (!entries.includes(".omp-isolation-owner.json")) continue;
		console.log("left on disk:", d, entries, "hasLiveIsolationOwner =", await hasLiveIsolationOwner(base));
	}
});
