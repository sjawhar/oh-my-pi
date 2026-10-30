import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";

test("paused process A starves unpaused process B of the provider slot", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-slot-"));
	const child = Bun.spawn(["bun", path.join(import.meta.dir, "holder.ts"), root], { stdout: "pipe", stderr: "inherit" });
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	console.log("child:", new TextDecoder().decode(value).trim());
	__providerInFlightForTesting.setRoot(root);
	registerMockApi();
	const mock = createMockModel({ provider: "tests", handler: async () => ({ content: ["B"] }) });
	const started = Date.now();
	const b = streamSimple(mock.model, { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] }, {
		maxInFlightRequests: { tests: 1 },
	}).result();
	const outcome = await Promise.race([b.then(m => `B done: ${m.stopReason}`), Bun.sleep(8000).then(() => "B still waiting")]);
	console.log(`after ${Date.now() - started}ms: ${outcome}`);
	child.kill("SIGKILL");
	await child.exited;
	await fs.rm(root, { recursive: true, force: true });
	expect(outcome).toStartWith("B done");
}, 20000);
