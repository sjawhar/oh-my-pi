import { expect, setSystemTime, test } from "bun:test";
const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages";
const { stream } = await import(`${HEAD}/ai/src/stream.ts`);
const { buildModel } = await import(`${HEAD}/catalog/src/build.ts`);
const { agentPauseGate } = await import(`${HEAD}/agent/src/pause.ts`);

function parseAmz(d: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d)!;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

test("Bedrock provider retry held by /pause goes out with the pre-pause SigV4 signature", async () => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	const attempts: { amzDate: string; wireAt: number }[] = [];
	const second = Promise.withResolvers<void>();
	const fetch = async (_input: unknown, init?: RequestInit) => {
		const h = new Headers(init?.headers);
		attempts.push({ amzDate: h.get("x-amz-date") ?? "", wireAt: Date.now() });
		if (attempts.length === 1) {
			// `/pause` engaged while attempt 1 is on the wire; provider answers 503.
			agentPauseGate.pause();
			return new Response("overloaded", { status: 503, headers: { "retry-after": "0" } });
		}
		second.resolve();
		return new Response("probe terminal", { status: 400 });
	};
	const s = stream(
		buildModel({
			id: "amazon.nova-lite-v1:0",
			name: "nova",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		}),
		{ systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] },
		{ maxHttpAttempts: 3, fetch, beforeDispatch: agentPauseGate.dispatchHold() },
	);
	const result = s.result();
	while (attempts.length < 1) await Bun.sleep(5);
	await Bun.sleep(3000); // retry backoff elapses; attempt 2 is now parked on the hold
	console.log("attempts on wire while paused:", attempts.length);
	// The human comes back 10 minutes later.
	setSystemTime(new Date(Date.now() + 10 * 60_000));
	agentPauseGate.resume();
	await Promise.race([second.promise, Bun.sleep(5000)]);
	setSystemTime();
	const msg = await result;
	for (const [i, a] of attempts.entries()) {
		console.log(`attempt ${i + 1}: x-amz-date=${a.amzDate} sent=${new Date(a.wireAt).toISOString()} signature age=${Math.round((a.wireAt - parseAmz(a.amzDate)) / 1000)}s`);
	}
	console.log("final stopReason:", msg.stopReason, msg.errorMessage?.slice(0, 80));
	expect(attempts.length).toBe(2);
	expect((attempts[1]!.wireAt - parseAmz(attempts[1]!.amzDate)) / 1000).toBeLessThan(300);
}, 20_000);
