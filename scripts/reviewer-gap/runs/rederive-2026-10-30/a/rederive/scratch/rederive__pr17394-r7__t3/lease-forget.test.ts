import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";
import { $ } from "bun";

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

async function setup(tag: string) {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `probe-${tag}-repo-`));
	await $`git init -q && git config user.email a@b && git config user.name a && echo hi > f.txt && git add . && git commit -qm init`
		.cwd(repo)
		.quiet();
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

for (const when of ["lease-after-old-teardown", "lease-during-old-teardown"] as const) {
	it(`successor's descendant lease survives the predecessor's teardown (${when})`, async () => {
		const repo = await setup(when);
		const id = "same-id";
		const a = await ensureIsolation(repo, id);

		// Hold A's teardown at isoStop (after the rename, before rm + forget).
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const realStop = natives.isoStop;
		let first = true;
		vi.spyOn(natives, "isoStop").mockImplementation(async (...args) => {
			if (first) {
				first = false;
				entered.resolve();
				await gate.promise;
			}
			return await realStop(...args);
		});
		const aTeardown = cleanupIsolation(a);
		await entered.promise;

		// Replacement spawn for the same id materialises while A's rm is in flight.
		const b = await ensureIsolation(repo, id);
		console.log("A gen", a.generation, "B gen", b.generation, "same mergedDir", a.mergedDir === b.mergedDir);
		const nested = path.join(b.mergedDir, "nested");
		await fs.mkdir(nested, { recursive: true });
		const data = path.join(nested, "descendant.txt");
		await fs.writeFile(data, "B's nested child is working here\n");

		let release: () => void = () => {};
		if (when === "lease-during-old-teardown") release = leaseIsolationWorkspace(nested);
		gate.resolve();
		await aTeardown;
		if (when === "lease-after-old-teardown") release = leaseIsolationWorkspace(nested);

		// B's owner tears down while its descendant still holds a lease.
		await cleanupIsolation(b);
		const survived = await Bun.file(data).exists();
		console.log(`[${when}] descendant data exists after B teardown while leased:`, survived);
		release();
		expect(survived).toBe(true);
	});
}
