import { expect, test } from "bun:test";
import { streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";
import type { ModelSpec } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";
import { agentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause";

const t0 = Date.now();
const log = (m: string) => console.log(`[+${Date.now() - t0}ms] ${m}`);

test("session-lifetime hold rejected inside the transport", async () => {
	const RESUME_MS = Number(process.env.RESUME_MS ?? 300);
	const m = buildModel({
		id: "gpt-x",
		name: "probe",
		api: "openai-completions",
		provider: "probe-openai",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1_000,
	} satisfies ModelSpec<"openai-completions">);
	// Mirrors AgentSession.#sideStreamFn: lifetime = request signal + session disposal.
	const request = new AbortController();
	const disposed = new AbortController();
	const lifetime = AbortSignal.any([request.signal, disposed.signal]);
	let wire = 0;
	let holdCalls = 0;
	const gateHold = agentPauseGate.dispatchHold(lifetime);
	const msg = await streamSimple(m, { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] }, {
		apiKey: "k",
		signal: request.signal,
		fetch: async () => {
			wire++;
			log(`WIRE request #${wire} sent; paused=${agentPauseGate.paused} sessionDisposed=${disposed.signal.aborted}`);
			return new Response(
				'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		},
		beforeDispatch: () => {
			holdCalls++;
			log(`hold call #${holdCalls}`);
			return gateHold();
		},
		onPayload: () => {
			// User presses /pause while the payload is built (after the chokepoint hold).
			agentPauseGate.pause();
			log("paused during payload build");
			setTimeout(() => {
				disposed.abort();
				log("session disposed while request held");
			}, 50);
			setTimeout(() => {
				agentPauseGate.resume();
				log("resumed");
			}, RESUME_MS);
			return undefined;
		},
	}).result();
	log(`result stopReason=${msg.stopReason} error=${msg.errorMessage ?? ""}`);
	log(`wire requests=${wire} hold calls=${holdCalls}`);
}, 60_000);
