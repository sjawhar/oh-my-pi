import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "/mnt/nvme/17394-astra-r7/head/packages/natives/native/index.js";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import { acquireFileLock, setWorktreesDir } from "/mnt/nvme/17394-astra-r7/head/packages/utils/src/index.ts";
import { $ } from "bun";

async function repo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await $`git init -q && git config user.email a@b && git config user.name a && echo hi > a.txt && git add . && git commit -qm init`.cwd(dir).quiet();
	return dir;
}

async function setup() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(base);
	return { r: await repo(), base };
}

afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

describe("probes", () => {
	it("P1-control: same steps without the overlapping old teardown", async () => {
		const { r } = await setup();
		const a = await ensureIsolation(r, "same-id-c");
		await cleanupIsolation(a);
		const b = await ensureIsolation(r, "same-id-c");
		const data = path.join(b.mergedDir, "nested-work.txt");
		await fs.writeFile(data, "nested child work\n");
		const lease = leaseIsolationWorkspace(b.mergedDir);
		await cleanupIsolation(b);
		console.log("P1-control gen B data exists while lease held:", await Bun.file(data).exists());
		lease();
	});

	it("P3-real: a slow materialisation makes a same-id teardown throw", async () => {
		const { r } = await setup();
		const old = await ensureIsolation(r, "p3r-id");
		const realStart = natives.isoStart;
		vi.spyOn(natives, "isoStart").mockImplementation(async (...args) => {
			await Bun.sleep(6000); // a clone of a large checkout
			return await realStart(...args);
		});
		const next = ensureIsolation(r, "p3r-id");
		await Bun.sleep(100);
		const t0 = Date.now();
		try {
			await cleanupIsolation(old);
			console.log("P3-real cleanup ok after", Date.now() - t0, "ms");
		} catch (e) {
			console.log("P3-real cleanupIsolation threw after", Date.now() - t0, "ms:", String(e));
		}
		await next;
	}, 20000);

	it("P1: old generation's teardown forgets the new generation's lease entry", async () => {
		const { r } = await setup();
		const a = await ensureIsolation(r, "same-id");
		const gate = Promise.withResolvers<void>();
		const realStop = natives.isoStop;
		let paused = false;
		vi.spyOn(natives, "isoStop").mockImplementation(async (...args) => {
			if (!paused) {
				paused = true;
				await gate.promise;
			}
			return await realStop(...args);
		});
		const cleanupA = cleanupIsolation(a); // renames, releases lock, pauses in isoStop
		await Bun.sleep(200);
		const b = await ensureIsolation(r, "same-id");
		gate.resolve();
		await cleanupA;
		const data = path.join(b.mergedDir, "nested-work.txt");
		await fs.writeFile(data, "nested child work\n");
		const lease = leaseIsolationWorkspace(b.mergedDir); // nested child of gen B
		await cleanupIsolation(b); // owner B ends
		console.log("P1 gen B data exists while lease held:", await Bun.file(data).exists());
		lease();
	});

	it("P2: lease taken while owner teardown is past its defer check", async () => {
		const { r } = await setup();
		const h = await ensureIsolation(r, "p2-id");
		const data = path.join(h.mergedDir, "nested-work.txt");
		await fs.writeFile(data, "nested child work\n");
		const cleanup = cleanupIsolation(h);
		const lease = leaseIsolationWorkspace(h.mergedDir);
		await cleanup;
		console.log("P2 data exists while lease held:", await Bun.file(data).exists());
		lease();
	});

	it("P3: lock contention > 5s fails materialisation", async () => {
		const { r, base } = await setup();
		const h = await ensureIsolation(r, "p3-id");
		const baseDir = path.dirname(h.mergedDir);
		const held = await acquireFileLock(baseDir); // stands in for a teardown/materialisation holding it
		setTimeout(() => held.release(), 6000);
		const t0 = Date.now();
		try {
			await ensureIsolation(r, "p3-id");
			console.log("P3 ensureIsolation ok after", Date.now() - t0, "ms");
		} catch (e) {
			console.log("P3 ensureIsolation threw after", Date.now() - t0, "ms:", String(e));
		}
	}, 20000);
});
