import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";

test("paused process keeps a cross-process in-flight lease while held", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slot-probe-"));
	__providerInFlightForTesting.setRoot(root);
	registerMockApi();
	const mock = createMockModel({ provider: "tests", handler: async () => ({ content: ["parent"] }) });
	// Stand-in for agentPauseGate.dispatchHold() while /pause is engaged.
	const gate = Promise.withResolvers<void>();
	let holdEntered = false;
	const ctl = new AbortController();
	const parent = streamSimple(
		mock.model,
		{ systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] },
		{
			maxInFlightRequests: { tests: 1 },
			signal: ctl.signal,
			beforeDispatch: () => {
				holdEntered = true;
				return gate.promise;
			},
		},
	);
	const parentResult = parent.result();
	while (!holdEntered) await Bun.sleep(5);
	console.log("PARENT held at beforeDispatch; leases on disk:", await fs.readdir(__providerInFlightForTesting.providerDir("tests")));
	const child = Bun.spawn(["bun", path.join(import.meta.dir, "slot-child.ts"), root, process.env.CHILD_MS ?? "3000"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(child.stdout).text();
	const err = await new Response(child.stderr).text();
	await child.exited;
	console.log(out.trim(), err.trim().slice(0, 400));
	gate.resolve();
	await parentResult;
	await fs.rm(root, { recursive: true, force: true });
}, 90_000);
