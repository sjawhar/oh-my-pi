import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";
import { cleanupIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import { writeIsolationOwner } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/isolation-ownership";

const SCRATCH = path.dirname(new URL(import.meta.url).pathname);

function setupFakeZfs(tag: string, baseDir: string): string {
	const bin = path.join(SCRATCH, "fakebin");
	fs.mkdirSync(bin, { recursive: true });
	const log = path.join(bin, `calls-${tag}.log`);
	fs.rmSync(log, { force: true });
	// The clone stays mounted at the path its `mountpoint` property names: the
	// ORIGINAL baseDir/m (zfs does not follow a rename of a parent directory).
	fs.writeFileSync(
		path.join(bin, "zfs"),
		`#!/bin/sh
echo "$@" >> ${log}
case "$1" in
  list) printf 'tank/src\\t/tank/src\\ntank/pi-iso-abc\\t${baseDir}/m\\n' ;;
  get) echo "tank/src@pi-iso-abc" ;;
  destroy) exit 0 ;;
  version) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	if (!process.env.PATH?.startsWith(bin)) throw new Error("run with PATH=fakebin:$PATH");
	return log;
}

async function makeSandbox(tag: string): Promise<{ baseDir: string; generation: string }> {
	const root = path.join(SCRATCH, `wt-${tag}`);
	fs.rmSync(root, { recursive: true, force: true });
	const baseDir = path.join(root, "sandbox");
	fs.mkdirSync(path.join(baseDir, "m"), { recursive: true });
	fs.writeFileSync(path.join(baseDir, "m", "work.txt"), "x");
	const generation = await writeIsolationOwner(baseDir, "Foo");
	return { baseDir, generation };
}

test("baseline: isoStop(Zfs) on the original path destroys the clone", async () => {
	const { baseDir } = await makeSandbox("base");
	const log = setupFakeZfs("base", baseDir);
	await natives.isoStop(natives.IsoBackendKind.Zfs, path.join(baseDir, "m"));
	console.log("BASELINE zfs calls:\n" + fs.readFileSync(log, "utf8"));
});

test("cleanupIsolation(Zfs): retired path no longer matches the dataset mountpoint", async () => {
	const { baseDir, generation } = await makeSandbox("patched");
	const log = setupFakeZfs("patched", baseDir);
	await cleanupIsolation({
		mergedDir: path.join(baseDir, "m"),
		generation,
		backend: natives.IsoBackendKind.Zfs,
		fellBack: false,
		fallbackReason: null,
	});
	console.log("PATCHED zfs calls:\n" + fs.readFileSync(log, "utf8"));
	console.log("dir listing after:", fs.readdirSync(path.dirname(baseDir)));
});

test("cleanupIsolation throws when the sandbox lock is held past its 5s acquire budget", async () => {
	const { baseDir, generation } = await makeSandbox("lock");
	const holder = await acquireFileLock(baseDir);
	setTimeout(() => holder.release(), 7000);
	const t0 = performance.now();
	let err: unknown;
	try {
		await cleanupIsolation({
			mergedDir: path.join(baseDir, "m"),
			generation,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
	} catch (e) {
		err = e;
	}
	console.log(`after ${Math.round(performance.now() - t0)}ms err=${String(err)} exists=${fs.existsSync(baseDir)}`);
}, 15000);
