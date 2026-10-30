import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const SRC = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/19fc56646504d68460e4f36534c9a2fa1b73cd24/packages/coding-agent/src";
const lease = await import(`${SRC}/task/isolation-lease.ts`);
const own = await import(`${SRC}/task/isolation-ownership.ts`);

async function makeSandbox() {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-probe-"));
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(path.join(mergedDir, "nested"), { recursive: true });
	await own.writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

it("double teardown: two concurrent lease releases", async () => {
	let doubles = 0;
	const N = 50;
	for (let i = 0; i < N; i++) {
		const { mergedDir } = await makeSandbox();
		lease.registerIsolationWorkspace(mergedDir);
		const a = await lease.leaseIsolationWorkspace(path.join(mergedDir, "nested"));
		const b = await lease.leaseIsolationWorkspace(path.join(mergedDir, "nested"));
		let runs = 0;
		expect(await lease.deferTeardownWhileLeased(mergedDir, async () => void (runs += 1))).toBe(true);
		await Promise.all([a(), b()]);
		if (runs > 1) doubles++;
		lease.forgetIsolationWorkspace(mergedDir);
	}
	console.log(`double-teardown: ${doubles}/${N} iterations ran the deferred teardown twice`);
});

it("lost teardown: release racing deferral", async () => {
	let lost = 0;
	const N = 200;
	for (let i = 0; i < N; i++) {
		const { mergedDir } = await makeSandbox();
		lease.registerIsolationWorkspace(mergedDir);
		const a = await lease.leaseIsolationWorkspace(path.join(mergedDir, "nested"));
		let runs = 0;
		const [deferred] = await Promise.all([
			lease.deferTeardownWhileLeased(mergedDir, async () => void (runs += 1)),
			a(),
		]);
		await Bun.sleep(5);
		if (deferred && runs === 0) lost++;
		lease.forgetIsolationWorkspace(mergedDir);
	}
	console.log(`lost-teardown: ${lost}/${N} iterations deferred the teardown and never ran it`);
});

it("foreign-process lease: owner's deferred teardown never runs", async () => {
	const { baseDir, mergedDir } = await makeSandbox();
	lease.registerIsolationWorkspace(mergedDir);
	const script = path.join(import.meta.dir, "foreign.ts");
	const child = Bun.spawn(["bun", script, path.join(mergedDir, "nested"), process.argv0], { stdout: "pipe", stderr: "inherit" });
	const reader = child.stdout.getReader();
	await reader.read(); // "leased"
	let runs = 0;
	const deferred = await lease.deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
	child.kill("SIGKILL");
	await child.exited;
	await Bun.sleep(200);
	console.log(`foreign SIGKILL: deferred=${deferred} runs=${runs} leaseLive=${await lease.hasLiveIsolationLease(baseDir)} sandboxExists=${await Bun.file(path.join(baseDir, own.ISOLATION_OWNER_FILE)).exists()}`);
	lease.forgetIsolationWorkspace(mergedDir);
});

it("foreign-process lease released cleanly: owner's deferred teardown never runs", async () => {
	const { baseDir, mergedDir } = await makeSandbox();
	lease.registerIsolationWorkspace(mergedDir);
	const script = path.join(import.meta.dir, "foreign.ts");
	const child = Bun.spawn(["bun", script, path.join(mergedDir, "nested"), "release"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	const reader = child.stdout.getReader();
	await reader.read();
	let runs = 0;
	const deferred = await lease.deferTeardownWhileLeased(mergedDir, async () => void (runs += 1));
	child.stdin.write("go\n");
	child.stdin.end();
	await child.exited;
	await Bun.sleep(200);
	console.log(`foreign clean release: deferred=${deferred} runs=${runs} leaseLive=${await lease.hasLiveIsolationLease(baseDir)}`);
	lease.forgetIsolationWorkspace(mergedDir);
});
