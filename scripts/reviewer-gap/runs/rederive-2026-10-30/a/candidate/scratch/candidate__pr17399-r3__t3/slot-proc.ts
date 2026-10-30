// Usage: bun slot-proc.ts <root> <role:paused|free>
const SNAP = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages";
const { __providerInFlightForTesting, streamSimple } = await import(`${SNAP}/ai/src/stream.ts`);
const { registerCustomApi } = await import(`${SNAP}/ai/src/api-registry.ts`);
const { AssistantMessageEventStream } = await import(`${SNAP}/ai/src/utils/event-stream.ts`);
const { agentPauseGate } = await import(`${SNAP}/agent/src/pause.ts`);

const [root, role] = process.argv.slice(2);
__providerInFlightForTesting.setRoot(root);
const API = "slot-probe";
const t0 = Date.now();
const log = (m: string) => console.log(`[${role} +${Date.now() - t0}ms] ${m}`);
registerCustomApi(API, () => {
	log("DISPATCHED to provider");
	const s = new AssistantMessageEventStream();
	const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: API, provider: "slot-provider", model: "m", timestamp: 1, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "stop", message }); });
	return s;
}, "slot-probe");
const model = { id: "m", name: "m", api: API, provider: "slot-provider", contextWindow: 1000, maxTokens: 100 };
const ctx = { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };

if (role === "paused") {
	agentPauseGate.pause(); // human hit /pause; this process's side request (title, memory...) is issued now
	log("paused gate engaged; issuing side request with dispatchHold");
	const hold = agentPauseGate.dispatchHold();
	streamSimple(model, ctx, { maxInFlightRequests: { "slot-provider": 1 }, beforeDispatch: () => { log("hold invoked (slot already acquired)"); return hold(); } }).result().then(() => log("done"));
	setInterval(() => {}, 1000);
} else {
	log("unpaused process issuing request");
	const timeout = setTimeout(() => { log("STILL WAITING for in-flight slot after 8000ms -> starved by paused process"); process.exit(2); }, 8000);
	await streamSimple(model, ctx, { maxInFlightRequests: { "slot-provider": 1 } }).result();
	clearTimeout(timeout);
	log("completed");
	process.exit(0);
}
