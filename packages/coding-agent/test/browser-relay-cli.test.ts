import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

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

	test("refuses --all-tabs when it cannot verify an existing relay's scope", async () => {
		const port = await findFreeCdpPort();
		const relay = startRelayServer({ port });
		try {
			const result = await runRelayCli("--port", String(port), "--all-tabs");
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("--all-tabs cannot change its scope");
			expect(result.output).toContain("Stop it and restart with --all-tabs.");
		} finally {
			relay.stop();
		}
	});
	test("install guides extension loading without enabling browser.relay globally", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-relay-"));
		try {
			const result = await runRelayCli("install", "--dir", directory);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Load unpacked");
			expect(result.output).not.toContain("omp config set browser.relay true");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

