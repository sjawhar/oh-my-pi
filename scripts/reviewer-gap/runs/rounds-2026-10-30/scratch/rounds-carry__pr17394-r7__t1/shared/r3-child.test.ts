import { it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureIsolation } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/packages/coding-agent/src/task/worktree";
import * as natives from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-natives";
import { setWorktreesDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/1ed7804e0fe4/node_modules/@oh-my-pi/pi-utils";

// Second omp process: materialise the same task id in the same repo.
it("second process materialises same id", async () => {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	setWorktreesDir(process.env.R3_WT!);
	const h = await ensureIsolation(process.env.R3_REPO!, process.env.R3_ID!);
	console.log("CHILD pid", process.pid, "generation", h.generation, "entries", (await fs.readdir(h.mergedDir)).sort().join(","));
	await fs.writeFile(path.join(h.mergedDir, "p2-work.txt"), "p2\n");
});
