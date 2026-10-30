// Usage: PROBE_ROOT=<root> PROBE_ROLE=<paused|free> bun test inflight-proc.test.ts
import { test } from "bun:test";
import { agentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause";
import { registerCustomApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/api-registry";
import { __providerInFlightForTesting, streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";
import type { Api, AssistantMessage, Model } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types";
import { AssistantMessageEventStream } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/event-stream";

const root = process.env.PROBE_ROOT!;
const role = process.env.PROBE_ROLE!;
__providerInFlightForTesting.setRoot(root);
const API = "probe-api" as Api;
const t0 = Date.now();
const log = (m: string) => console.log(`[${role} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
registerCustomApi(
	API,
	() => {
		log("DISPATCHED to provider (wire)");
		const s = new AssistantMessageEventStream();
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: API,
			provider: "probe-provider",
			model: "m",
			timestamp: 1,
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} as AssistantMessage;
		queueMicrotask(() => {
			s.push({ type: "start", partial: message });
			s.push({ type: "done", reason: "stop", message });
		});
		return s;
	},
	"probe",
);
const model = { id: "m", name: "m", api: API, provider: "probe-provider", contextWindow: 1000, maxTokens: 100 } as Model<Api>;
test("probe", async () => {
if (role === "paused") agentPauseGate.pause();
log(`gate paused=${agentPauseGate.paused}; starting request`);
const msg = await streamSimple(model, { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] }, {
	maxInFlightRequests: { "probe-provider": 1 },
	beforeDispatch: agentPauseGate.dispatchHold(),
}).result();
log(`request finished stopReason=${msg.stopReason}`);
}, 120_000);
