import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";
import { stream } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";
import type { Api, AssistantMessage, Context, FetchImpl, ModelSpec, OptionsForApi } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types";

const realSetImmediate = globalThis.setImmediate;
const BUDGET_MS = 1_000;
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}
function pauseAfter(passes: number) {
	let calls = 0;
	let parks = 0;
	let open = false;
	const parked = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		hold: (): Promise<void> | undefined => {
			calls++;
			if (open || calls <= passes) return undefined;
			parks++;
			parked.resolve();
			return gate.promise;
		},
		parked: parked.promise,
		get parks() { return parks; },
		get calls() { return calls; },
		release: () => { open = true; gate.resolve(); },
	};
}
function stall(signal: AbortSignal | null | undefined): Promise<Response> {
	const pending = Promise.withResolvers<Response>();
	signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
	return pending.promise;
}
const common = { name: "x", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000 };
const context: Context = { systemPrompt: ["test"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const cases: { name: string; spec: ModelSpec<Api>; options: Record<string, unknown> }[] = [
	{
		name: "Gemini CLI",
		spec: { ...common, id: "gemini-2.5-flash", api: "google-gemini-cli", provider: "google-gemini-cli", baseUrl: "https://cloudcode-pa.example" } as ModelSpec<Api>,
		options: { apiKey: JSON.stringify({ token: "t", projectId: "p" }) },
	},
];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

for (const entry of cases) {
	it(`${entry.name}: pause inside transport past budget`, async () => {
		const pause = pauseAfter(1);
		const wireUrls: string[] = [];
		const fetch: FetchImpl = async (input, init) => {
			wireUrls.push(input instanceof Request ? input.url : String(input));
			return stall(init?.signal);
		};
		let settled: AssistantMessage | undefined;
		void stream(buildModel(entry.spec), context, {
			...entry.options,
			streamFirstEventTimeoutMs: BUDGET_MS,
			streamIdleTimeoutMs: BUDGET_MS,
			maxHttpAttempts: 1,
			maxRetryDelayMs: 1,
			providerRetryWait: async () => {},
			beforeDispatch: pause.hold,
			fetch,
		} as OptionsForApi<Api>).result().then(m => { settled = m; });
		await pause.parked;
		for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(BUDGET_MS); await settle(); }
		console.log(entry.name, JSON.stringify({ settled: settled && { stop: settled.stopReason, err: settled.errorMessage }, wire: wireUrls.length, parks: pause.parks, calls: pause.calls }));
		pause.release();
		await settle();
		console.log(entry.name, "after release", JSON.stringify({ wire: wireUrls.length }));
	});
}
