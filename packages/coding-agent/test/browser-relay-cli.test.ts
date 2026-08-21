import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");

async function runRelayCli(...args: string[]): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn([process.execPath, "src/cli.ts", "browser-relay", ...args], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

describe("omp browser-relay", () => {
	test("lists the explicit all-tabs opt-out and rejects the removed no-group flag", async () => {
		const help = await runRelayCli("--help");
		expect(help.exitCode).toBe(0);
		expect(help.output).toContain("--all-tabs");
		expect(help.output).not.toContain("--no-group");

		const removedFlag = await runRelayCli("--no-group");
		expect(removedFlag.exitCode).not.toBe(0);
		expect(removedFlag.output).toMatch(/unknown (option|flag)/i);
	});
});
