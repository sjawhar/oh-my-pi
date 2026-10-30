// Second, UNPAUSED omp process sharing the provider in-flight directory.
import { createMockModel, registerMockApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";

__providerInFlightForTesting.setRoot(process.argv[2]);
registerMockApi();
const mock = createMockModel({ provider: "tests", handler: async () => ({ content: ["child reply"] }) });
const t0 = Date.now();
process.on("uncaughtException", e => {
	console.log(`CHILD blocked: ${String(e)} waitedMs=${Date.now() - t0} dispatched=${mock.calls.length}`);
	process.exit(0);
});
const signal = AbortSignal.timeout(Number(process.argv[3]));
const msg = await streamSimple(
	mock.model,
	{ systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] },
	{ maxInFlightRequests: { tests: 1 }, signal },
).result();
console.log(`CHILD stopReason=${msg.stopReason} dispatched=${mock.calls.length} waitedMs=${Date.now() - t0}`);
process.exit(0);
