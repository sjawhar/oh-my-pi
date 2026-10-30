import { afterEach, beforeEach, it, vi } from "bun:test";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";
import { stream } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";
import type { Api, AssistantMessage, Context, FetchImpl, ModelSpec, OptionsForApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types";

const realSetImmediate = globalThis.setImmediate;
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}
function pauseAfter(passes: number) {
	let calls = 0;
	let open = false;
	const parked = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		hold: (): Promise<void> | undefined => {
			calls++;
			if (open || calls <= passes) return undefined;
			parked.resolve();
			return gate.promise;
		},
		parked: parked.promise,
		get calls() { return calls; },
		release: () => { open = true; gate.resolve(); },
	};
}
const context: Context = { systemPrompt: ["test"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const spec = {
	name: "x", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000,
	id: "amazon.nova-lite-v1:0", api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
} as ModelSpec<Api>;

function amzDateToMs(v: string): number {
	// 20261030T065000Z
	return Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
}

beforeEach(() => { process.env.AWS_BEDROCK_SKIP_AUTH = "1"; process.env.AWS_REGION = "us-east-1"; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete process.env.AWS_BEDROCK_SKIP_AUTH; });

it("SigV4 request held across a 20-minute pause", async () => {
	const pause = pauseAfter(1);
	const wire: { amzDate: string; skewSec: number }[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		const amzDate = h.get("x-amz-date") ?? "";
		const skewSec = Math.round((Date.now() - amzDateToMs(amzDate)) / 1000);
		wire.push({ amzDate, skewSec });
		// AWS rejects a SigV4 request whose X-Amz-Date is more than 5 minutes off.
		if (skewSec > 300) {
			return new Response(JSON.stringify({ message: "Signature expired: is now earlier than ... (5 min)" }), {
				status: 403,
				headers: { "x-amzn-errortype": "InvalidSignatureException" },
			});
		}
		return new Response(JSON.stringify({ message: "ok-but-stop" }), { status: 400 });
	};
	let settled: AssistantMessage | undefined;
	void stream(buildModel(spec), context, {
		maxHttpAttempts: 1, maxRetryDelayMs: 1, providerRetryWait: async () => {},
		beforeDispatch: pause.hold,
		fetch,
	} as OptionsForApi<Api>).result().then(m => { settled = m; });
	await pause.parked;
	console.log("parked at transport hold after", pause.calls, "hold calls; wire so far:", wire.length);
	for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(60_000); await settle(); }
	pause.release();
	for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(1_000); await settle(); }
	console.log("wire:", JSON.stringify(wire));
	console.log("result:", JSON.stringify({ stop: settled?.stopReason, err: settled?.errorMessage }));
});
