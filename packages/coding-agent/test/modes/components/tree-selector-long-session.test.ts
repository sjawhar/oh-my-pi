import { describe, expect, test } from "bun:test";
import * as path from "node:path";

// Opening the tree over a 10,000-entry chain must retain memory linear in its
// entries. Copying each row's ancestor list instead retains ~400 MB here, and
// a real 74k-entry session needed 40 GB and 20 s before the tree appeared.
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const probePath = path.resolve(import.meta.dir, "../../fixtures", "tree-selector-long-session-probe.ts");

describe("session tree on a long session", () => {
	test("opening it at the leaf retains memory linear in the session length", async () => {
		const proc = Bun.spawn([process.execPath, "--smol", probePath], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const [retained, selected] = stdout.trim().split("\n");
		const retainedBytes = Number(retained);
		if (!Number.isFinite(retainedBytes)) throw new Error(`invalid probe output: ${stdout}`);
		// The selection reached the leaf, so the whole chain was projected.
		expect(selected).toBe("e9999");
		expect(retainedBytes).toBeLessThan(MAX_RETAINED_BYTES);
	});
});
