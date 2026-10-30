import { expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const OWNERSHIP = path.resolve(import.meta.dir, "../../../../heads/5e70deb62c2185d777378adb51c06ec8f67a9cd6/packages/coding-agent/src/task/isolation-ownership.ts");
const real = await import(OWNERSHIP);

// Barrier: hold markUnfinishedWriter between its sandbox lookup (T1) and its write (T2).
let reachedWrite!: () => void;
const atWrite = new Promise<void>(r => (reachedWrite = r));
let releaseWrite!: () => void;
const writeGate = new Promise<void>(r => (releaseWrite = r));
const realWrite = real.writeProcessIdentity;
mock.module(OWNERSHIP, () => ({
	...real,
	writeProcessIdentity: async (file: string, extra?: Record<string, unknown>) => {
		if (file.includes(".omp-isolation-unfinished")) {
			reachedWrite();
			await writeGate;
		}
		return realWrite(file, extra);
	},
}));

const SRC = path.dirname(path.dirname(OWNERSHIP));
const lease = await import(path.join(SRC, "task/isolation-lease.ts"));
const worktree = await import(path.join(SRC, "task/worktree.ts"));
const natives = await import(Bun.resolveSync("@oh-my-pi/pi-natives", path.join(SRC, "task")));

it("writer record written after teardown decided lands in a ghost dir", async () => {
	const root = await real.resolveSandboxIdentity(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wr-")));
	const baseDir = path.join(root, "tabc-1");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await fs.writeFile(path.join(mergedDir, "work.txt"), "the shutdown handler is still saving this");
	const generation = await real.writeIsolationOwner(baseDir, "owner-agent");
	lease.registerIsolationWorkspace(mergedDir, { baseDir, generation, agentId: "owner-agent" });

	// T1: a session in the sandbox starts disposal and records itself as an unfinished writer.
	const record = lease.markUnfinishedWriter(path.join(mergedDir));
	await atWrite; // findSandboxBase has seen a "claimed" sandbox; write not yet done

	// Window: the owner's teardown runs (no lock is held by markUnfinishedWriter).
	const backend = (natives as any).IsoBackendKind;
	console.log("IsoBackendKind", JSON.stringify(backend));
	const kind = Object.values(backend).find(v => typeof v === "number") as number;
	await worktree.cleanupIsolation({ mergedDir, generation, backend: kind, fellBack: false, fallbackReason: null } as any);
	console.log("after teardown, baseDir exists:", await fs.exists(baseDir));

	// T2: the write proceeds against the pathname resolved at T1.
	releaseWrite();
	const clear = await record;
	console.log("work.txt survives:", await fs.exists(path.join(mergedDir, "work.txt")));
	console.log("baseDir now contains:", await fs.readdir(baseDir).catch(e => String(e)));
	console.log("hasUnfinishedWriter(baseDir):", await lease.hasUnfinishedWriter(baseDir));
	const { decideIsolationReclaim } = real;
	console.log("reclaim decision:", JSON.stringify(await decideIsolationReclaim(baseDir)));
	await clear();
	console.log("after clear, baseDir contains:", await fs.readdir(baseDir).catch(e => String(e)));
	console.log("reclaim decision after clear:", JSON.stringify(await decideIsolationReclaim(baseDir)));
	await fs.rm(root, { recursive: true, force: true });
	expect(true).toBe(true);
});
