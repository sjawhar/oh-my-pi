import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src";

test("a paused request in process A holds the provider in-flight slot process B needs", async () => {
	const { createMockModel, registerMockApi } = await import(`${H}/providers/mock`);
	const { __providerInFlightForTesting, streamSimple } = await import(`${H}/stream`);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "slot-probe-"));
	const child = Bun.spawn(["bun", path.join(import.meta.dir, "slot-child.ts")], {
		env: { ...process.env, LIMIT_ROOT: root },
		stdout: "pipe",
		stderr: "inherit",
	});
	// Wait for the child to reach its hold.
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	console.log(new TextDecoder().decode(value).trim());

	__providerInFlightForTesting.setRoot(root);
	registerMockApi();
	const mock = createMockModel({ provider: "tests", handler: async () => ({ content: ["parent"] }) });
	const t0 = Date.now();
	const s = streamSimple(mock.model, { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] }, {
		maxInFlightRequests: { tests: 1 },
	});
	const outcome = await Promise.race([
		s.result().then(m => `dispatched: ${JSON.stringify(m.content)}`),
		Bun.sleep(40_000).then(() => "STILL WAITING"),
	]);
	console.log(`PARENT (not paused) after ${Date.now() - t0}ms: ${outcome}`);
	const leases = await fs.readdir(path.join(root), { recursive: true });
	console.log("lease dir entries:", leases);
	child.kill();
	await fs.rm(root, { recursive: true, force: true });
}, 60_000);
