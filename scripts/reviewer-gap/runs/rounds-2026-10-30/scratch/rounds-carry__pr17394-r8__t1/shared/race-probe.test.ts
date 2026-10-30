import { afterEach, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function sandbox() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "probe-race-")));
	dirs.push(root);
	const baseDir = path.join(root, "t-sandbox");
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "probe");
	return { baseDir, mergedDir };
}

it("G: lease released while deferTeardownWhileLeased is deciding strands the teardown (single process)", async () => {
	const N = 200;
	let stranded = 0;
	let deferredCount = 0;
	let ranImmediately = 0;
	for (let i = 0; i < N; i++) {
		const { baseDir, mergedDir } = await sandbox();
		registerIsolationWorkspace(mergedDir);
		try {
			const release = await leaseIsolationWorkspace(mergedDir);
			let torndown = 0;
			const teardown = async () => void (torndown += 1);
			// sdk.ts:4516 shape: dispose fires `void workspaceLease()` and returns;
			// the owner's releaseIsolation then asks deferTeardownWhileLeased.
			const releasing = release();
			if (process.env.PROBE_GAP === "1") await fs.readdir(baseDir).catch(() => undefined);
			const deferred = await deferTeardownWhileLeased(mergedDir, teardown);
			if (!deferred) await teardown();
			await releasing;
			await Bun.sleep(1);
			const live = await hasLiveIsolationLease(baseDir);
			if (deferred) deferredCount++;
			else ranImmediately++;
			if (deferred && torndown === 0 && !live) stranded++;
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	}
	console.log(`G trials=${N} deferred=${deferredCount} ranImmediately=${ranImmediately} stranded(no lease left, teardown never ran)=${stranded}`);
});
