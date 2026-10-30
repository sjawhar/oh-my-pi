import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { markIsolationRetired } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

let base: string;
let outside: string;
beforeEach(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "probe-wt-"));
	outside = await fs.mkdtemp(path.join(os.tmpdir(), "probe-victim-"));
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(base);
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	await fs.rm(base, { recursive: true, force: true });
	await fs.rm(outside, { recursive: true, force: true });
});

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

it("--all: symlink entry in the worktrees dir -> target outside it", async () => {
	const victim = path.join(outside, "project");
	await fs.mkdir(path.join(victim, "m"), { recursive: true });
	await Bun.write(path.join(victim, "m", "precious.txt"), "user data\n");
	const link = path.join(base, "tlink0001");
	await fs.symlink(victim, link);

	const out = await clearWorktrees({ all: true, dryRun: false, json: true });
	console.error("result:", JSON.stringify(out));
	console.error("link still exists:", await exists(link), "(lstat)", await fs.lstat(link).then(() => true, () => false));
	console.error("victim outside worktrees dir still exists:", await exists(victim));
	console.error("precious.txt exists:", await exists(path.join(victim, "m", "precious.txt")));
});

it("no --all: symlink entry -> retired sandbox outside worktrees dir", async () => {
	const victim = path.join(outside, "elsewhere");
	await fs.mkdir(path.join(victim, "m"), { recursive: true });
	await Bun.write(path.join(victim, "m", "precious.txt"), "user data\n");
	await markIsolationRetired(victim);
	const link = path.join(base, "tlink0002");
	await fs.symlink(victim, link);
	await clearWorktrees({ all: false, dryRun: false, json: true });
	console.error("[no --all] link lstat exists:", await fs.lstat(link).then(() => true, () => false));
	console.error("[no --all] victim exists:", await exists(victim));
});
