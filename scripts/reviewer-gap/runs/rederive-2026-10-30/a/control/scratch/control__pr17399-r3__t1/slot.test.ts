import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const S = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src";
const { clearCustomApis } = await import(`${S}/api-registry.ts`);
const { createMockModel, registerMockApi } = await import(`${S}/providers/mock.ts`);
const { __providerInFlightForTesting, streamSimple } = await import(`${S}/stream.ts`);
type Context = any;

let root: string | undefined;
afterEach(async () => {
	clearCustomApis();
	__providerInFlightForTesting.setRoot(undefined);
	if (root) await fs.rm(root, { recursive: true, force: true });
});

const ctx = (): Context => ({ systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] });

test("a request parked on a closed hold keeps the cross-process in-flight permit", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-slot-"));
	__providerInFlightForTesting.setRoot(root);
	registerMockApi();
	const mock = createMockModel({ provider: "tests", handler: async () => ({ content: ["ok"] }) });
	const pause = Promise.withResolvers<void>();
	const abort = new AbortController();
	// "Paused" session: its side request is held at the chokepoint.
	const held = streamSimple(mock.model, ctx(), {
		maxInFlightRequests: { tests: 1 },
		beforeDispatch: () => pause.promise,
		signal: abort.signal,
	});
	void held.result();
	await Bun.sleep(100);
	const leases = (await fs.readdir(root, { recursive: true })).filter(f => !f.endsWith(".wakeup"));
	console.log("lease entries while paused:", leases);
	// Another, unpaused session sharing the limiter.
	const t0 = Date.now();
	const other = streamSimple(mock.model, ctx(), { maxInFlightRequests: { tests: 1 } }).result();
	const outcome = await Promise.race([other.then(() => "completed"), Bun.sleep(1500).then(() => "starved")]);
	console.log("unpaused request after", Date.now() - t0, "ms:", outcome);
	pause.resolve();
	await other;
	expect(outcome).toBe("starved");
});
