import { expect, test } from "bun:test";
import { acquireFileLock } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/utils/src/file-lock";

test("second in-process acquire of a held sandbox lock", async () => {
	const dir = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/a/control/scratch/control__pr17394-r7__t2/wt-x";
	const first = await acquireFileLock(dir);
	const t0 = Date.now();
	let err: unknown;
	try {
		const second = await acquireFileLock(dir);
		second.release();
	} catch (e) {
		err = e;
	}
	console.log("elapsed", Date.now() - t0, "error:", String(err));
	first.release();
	expect(err).toBeDefined();
}, 20_000);
