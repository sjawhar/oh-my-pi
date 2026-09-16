/**
 * Contract tests for the tool-child credential scrub: provider credential env
 * vars in the harness process env must not reach bash-tool subprocesses by
 * default, `PI_KEEP_PROVIDER_KEYS` restores passthrough, and non-credential
 * vars flow through untouched. The embedded shell inherits the REAL process
 * environment (Rust `std::env`), which `process.env` assignment in Bun does
 * not update, so each case spawns a child probe with the sentinel in its
 * spawn env instead of mutating this process.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROBE_PATH = path.join(import.meta.dir, "fixtures", "bash-scrub-probe.ts");

async function runProbe(
	envOverrides: Record<string, string>,
): Promise<{ exitCode: number | undefined; output: string }> {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scrub-probe-"));
	const proc = Bun.spawn([process.execPath, PROBE_PATH], {
		cwd: agentDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			...envOverrides,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// Real-timer watchdog only: it bounds a wedged CHILD PROCESS, whose clock
	// fake timers cannot control. It fires only on failure.
	const watchdog = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}, 55_000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		return JSON.parse(stdout.trim()) as { exitCode: number | undefined; output: string };
	} finally {
		clearTimeout(watchdog);
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

describe("bash tool-child credential scrub", () => {
	it("hides provider credentials from bash children while non-credential vars pass through", async () => {
		const result = await runProbe({
			ANTHROPIC_API_KEY: "sk-scrub-sentinel",
			OMP_SCRUB_PASSTHROUGH_PROBE: "kept",
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("unset|kept");
	}, 60_000);

	it("passes provider credentials through when PI_KEEP_PROVIDER_KEYS is set", async () => {
		const result = await runProbe({
			ANTHROPIC_API_KEY: "sk-scrub-sentinel",
			OMP_SCRUB_PASSTHROUGH_PROBE: "kept",
			PI_KEEP_PROVIDER_KEYS: "1",
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("sk-scrub-sentinel|kept");
	}, 60_000);
});
