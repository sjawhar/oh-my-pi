// Process A: a paused process. Its request acquires the cross-process in-flight
// slot, then parks on the pause hold (agentPauseGate.dispatchHold) at the chokepoint.
import { agentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause";
import { createMockModel, registerMockApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";

const root = process.argv[2]!;
__providerInFlightForTesting.setRoot(root);
registerMockApi();
let wire = 0;
const mock = createMockModel({ provider: "tests", handler: async () => { wire++; return { content: ["A"] }; } });
agentPauseGate.pause();
const s = streamSimple(mock.model, { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] }, {
	maxInFlightRequests: { tests: 1 },
	beforeDispatch: agentPauseGate.dispatchHold(),
});
void s.result();
setTimeout(() => console.log(`A parked wire=${wire}`), 300);
setInterval(() => {}, 1000);
