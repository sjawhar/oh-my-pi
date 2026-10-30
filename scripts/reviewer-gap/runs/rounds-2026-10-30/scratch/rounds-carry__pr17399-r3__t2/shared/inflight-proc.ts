// Usage: bun inflight-proc.ts <role: holder|contender> <root>
import { agentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause.ts";
import { createMockModel, registerMockApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/mock.ts";
import { __providerInFlightForTesting, streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream.ts";

const [role, root] = process.argv.slice(2);
__providerInFlightForTesting.setRoot(root);
registerMockApi();
const t0 = Date.now();
const log = (m: string) => console.log(`[${role} +${Date.now() - t0}ms] ${m}`);
const mock = createMockModel({
	provider: "tests",
	handler: async () => {
		log("provider dispatched");
		return { content: ["ok"] };
	},
});
const ctx = { systemPrompt: [], messages: [{ role: "user" as const, content: "go", timestamp: 0 }] };

if (role === "holder") {
	// This process's human pressed /pause; a side request (e.g. compaction) carries the gate's hold.
	agentPauseGate.pause();
	const s = streamSimple(mock.model, ctx, {
		maxInFlightRequests: { tests: 1 },
		beforeDispatch: agentPauseGate.dispatchHold(),
	});
	void s.result();
	log("holder request issued while paused; staying paused");
	await Bun.sleep(Number(process.env.HOLD_MS ?? 8000));
	log("holder resuming");
	agentPauseGate.resume();
	await s.result();
	log("holder done");
} else {
	log("contender (not paused) issuing request");
	const r = await streamSimple(mock.model, ctx, { maxInFlightRequests: { tests: 1 } }).result();
	log(`contender result stopReason=${r.stopReason}`);
}
process.exit(0);
