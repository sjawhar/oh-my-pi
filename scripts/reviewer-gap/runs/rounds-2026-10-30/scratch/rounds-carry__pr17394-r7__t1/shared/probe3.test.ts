import { afterEach, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { leaseIsolationWorkspace } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-lease";
import { cleanupIsolation, ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

async function git(cwd: string, args: string[]) {
	await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}
async function setup() {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	setWorktreesDir(await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-")));
	delete process.env.OMP_WORKTREE_DIR;
	const r = await fs.mkdtemp(path.join(os.tmpdir(), "probe-repo-"));
	await git(r, ["init", "-q", "-b", "main"]);
	await fs.writeFile(path.join(r, "f.txt"), "x\n");
	await git(r, ["add", "."]);
	await git(r, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"]);
	return r;
}
afterEach(() => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
});

it("control: A's teardown finished before B materialised", async () => {
	const r = await setup();
	const a = await ensureIsolation(r, "ctl-id");
	await cleanupIsolation(a);
	const b = await ensureIsolation(r, "ctl-id");
	const nested = path.join(b.mergedDir, "nested");
	await fs.mkdir(nested, { recursive: true });
	const data = path.join(nested, "descendant.txt");
	await fs.writeFile(data, "descendant work\n");
	const release = leaseIsolationWorkspace(nested);
	await cleanupIsolation(b);
	console.log("control: descendant data after B cleanup while leased:", await Bun.file(data).exists());
	release();
	await scheduler.wait(100);
});

it("two concurrent materialisations of one id, first takes >5s", async () => {
	const r = await setup();
	const realStart = natives.isoStart;
	let n = 0;
	vi.spyOn(natives, "isoStart").mockImplementation(async (...args) => {
		if (n++ === 0) await scheduler.wait(6000);
		return await realStart(...args);
	});
	const first = ensureIsolation(r, "dup-id").then(h => `ok ${h.generation}`, e => String(e));
	await scheduler.wait(50);
	const second = ensureIsolation(r, "dup-id").then(h => `ok ${h.generation}`, e => String(e));
	console.log("first:", await first);
	console.log("second:", await second);
}, 30000);
