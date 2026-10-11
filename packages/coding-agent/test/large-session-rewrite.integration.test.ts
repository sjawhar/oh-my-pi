import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	sourceBytes: number;
	rewrittenBytes: number;
	peakBytes: number;
	retainedBytes: number;
	rewriteComplete: boolean;
}

const SHOULD_RUN = Bun.env.PI_SESSION_2GIB_INTEGRATION === "1";
const MAX_PEAK_BYTES = 5 * 1024 ** 3;
const MAX_RETAINED_BYTES = 512 * 1024 ** 2;
const probePath = path.resolve(import.meta.dir, "fixtures", "large-session-rewrite-probe.ts");

async function runProbe(): Promise<ProbeResult> {
	const proc = Bun.spawn(
		[
			"systemd-run",
			"--user",
			"--scope",
			"-q",
			"-p",
			"MemoryMax=8G",
			"-p",
			"MemorySwapMax=0",
			process.execPath,
			probePath,
		],
		{ cwd: path.resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const result = JSON.parse(stdout) as ProbeResult;
	if (
		!Number.isFinite(result.sourceBytes) ||
		!Number.isFinite(result.rewrittenBytes) ||
		!Number.isFinite(result.peakBytes) ||
		!Number.isFinite(result.retainedBytes)
	) {
		throw new Error(`invalid large-rewrite probe output: ${stdout}`);
	}
	return result;
}

describe.skipIf(!SHOULD_RUN)("multi-gibabyte session rewrite", () => {
	test(
		"rewrites a synthetic session beyond the string limit within the memory cap",
		async () => {
			const result = await runProbe();

			expect(result.rewriteComplete).toBe(true);
			expect(result.sourceBytes).toBeGreaterThan(2 ** 31);
			expect(result.rewrittenBytes).toBeGreaterThan(2 ** 31);
			expect(result.peakBytes, JSON.stringify(result)).toBeLessThan(MAX_PEAK_BYTES);
			expect(result.retainedBytes, JSON.stringify(result)).toBeLessThan(MAX_RETAINED_BYTES);
		},
		15 * 60_000,
	);
});
