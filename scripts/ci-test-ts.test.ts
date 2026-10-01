import { describe, expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { buildChildEnv, selectShard } from "./ci-test-ts";

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("omp-test-runner-watchdog-");
		const started = dir.join("started");
		const completed = dir.join("completed");
		const continued = dir.join("continued");
		const stalledCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(completed)}, "completed");`,
		];
		const nextCommand = [process.execPath, "-e", `await Bun.write(${JSON.stringify(continued)}, "continued");`];
		const commands = [
			{ label: "stalled chunk", cwd: ".", command: stalledCommand },
			{ label: "following chunk", cwd: ".", command: nextCommand },
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel(${JSON.stringify(commands)}, 1);`,
			],
			{
				env: { ...Bun.env, OMP_TEST_CHUNK_TIMEOUT: "1", NO_COLOR: "1" },
				timeout: 10_000,
				detached: true,
				allowNonZero: true,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("[watchdog]");
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});

describe("OMP_TEST_SHARD", () => {
	test("shards partition every chunk exactly once, balanced to within one", () => {
		const chunks = Array.from({ length: 79 }, (_, i) => i);
		const shards = [1, 2, 3].map(i => selectShard(chunks, `${i}/3`));
		expect(shards.flat().sort((a, b) => a - b)).toEqual(chunks);
		const sizes = shards.map(s => s.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
		expect(selectShard(chunks, "1/1")).toEqual(chunks);
		expect(selectShard(chunks, undefined)).toEqual(chunks);
	});

	test("rejects malformed specs instead of running an empty or partial shard", () => {
		for (const spec of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) {
			expect(() => selectShard([1, 2, 3], spec)).toThrow("Invalid OMP_TEST_SHARD");
		}
	});

	test("rejects a shard that selects no chunks", () => {
		expect(() => selectShard([1], "2/2")).toThrow("selects no chunks");
		expect(() => selectShard([], "1/1")).toThrow("selects no chunks");
	});
});

describe("test child environment", () => {
	test("strips omp configuration, credentials and the terminal session, keeps harness controls, and pins the runner's values", () => {
		const env = buildChildEnv({
			PATH: "/usr/bin",
			PI_EDIT_VARIANT: "replace",
			PI_CONFIG_FILES: "/home/dev/overlay.yml",
			OMP_AUTH_BROKER_TOKEN: "broker-token",
			MNEMOPI_EMBEDDING_API_URL: "http://127.0.0.1:8080",
			SEARXNG_BASIC_PASSWORD: "searx",
			HINDSIGHT_API_TOKEN: "hindsight",
			ANTHROPIC_API_KEY: "sk-ant",
			OMP_TEST_SHARD: "2/3",
			OMP_E2E_GATEWAY_URL: "http://127.0.0.1:4000",
			PI_PYTHON_INTEGRATION: "1",
			AWS_EC2_METADATA_DISABLED: "false",
			PI_NO_DOTENV: "",
			PI_TEST_RUNTIME: "0",
			SSH_CONNECTION: "203.0.113.7 51234 10.0.0.2 22",
			TMUX_PANE: "%3",
			TERM_PROGRAM: "tmux",
			COLORTERM: "truecolor",
			TERM: "xterm-256color",
			SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
		});

		for (const key of [
			"PI_EDIT_VARIANT",
			"PI_CONFIG_FILES",
			"OMP_AUTH_BROKER_TOKEN",
			"MNEMOPI_EMBEDDING_API_URL",
			"SEARXNG_BASIC_PASSWORD",
			"HINDSIGHT_API_TOKEN",
			"ANTHROPIC_API_KEY",
			"SSH_CONNECTION",
			"TMUX_PANE",
			"TERM_PROGRAM",
			"COLORTERM",
		]) {
			expect(env[key], key).toBeUndefined();
		}
		expect(env).toMatchObject({
			PATH: "/usr/bin",
			OMP_TEST_SHARD: "2/3",
			OMP_E2E_GATEWAY_URL: "http://127.0.0.1:4000",
			PI_PYTHON_INTEGRATION: "1",
			TERM: "xterm-256color",
			SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
			AWS_EC2_METADATA_DISABLED: "true",
			PI_NO_DOTENV: "1",
			PI_TEST_RUNTIME: "1",
		});
	});
});
