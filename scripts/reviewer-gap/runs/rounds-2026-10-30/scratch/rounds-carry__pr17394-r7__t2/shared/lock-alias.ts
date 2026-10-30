import * as fs from "node:fs";
import * as path from "node:path";
const U = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/utils/src/file-lock.ts";
const { acquireFileLock } = await import(U);
const [, , mode, target] = process.argv;
if (mode === "child") {
	try {
		const l = await acquireFileLock(target, { retries: 1 });
		console.log(`child pid ${process.pid}: acquired lock on ${target}`);
		l.release();
	} catch (e) {
		console.log(`child pid ${process.pid}: refused: ${(e as Error).message}`);
	}
	process.exit(0);
}
const root = fs.mkdtempSync("/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/rounds-carry__pr17394-r7__t2/shared/alias-");
fs.mkdirSync(path.join(root, "wt", "task-x"), { recursive: true });
fs.symlinkSync(path.join(root, "wt"), path.join(root, "wt-link"));
const realBase = path.join(root, "wt", "task-x");
const aliasBase = path.join(root, "wt-link", "task-x");
const held = await acquireFileLock(realBase);
console.log(`parent pid ${process.pid}: holds lock on ${realBase}`);
for (const t of [realBase, aliasBase]) {
	const p = Bun.spawnSync(["bun", import.meta.path, "child", t]);
	process.stdout.write(p.stdout.toString());
}
held.release();
