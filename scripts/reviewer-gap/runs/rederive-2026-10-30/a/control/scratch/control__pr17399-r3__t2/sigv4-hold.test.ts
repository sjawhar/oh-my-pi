import { expect, test } from "bun:test";
import { createBedrockMantleAuthenticatedFetch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/bedrock-mantle";
import { transportFetch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/transport-fetch";

test("SigV4 signature is computed before the dispatch hold parks", async () => {
	process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
	process.env.AWS_SECRET_ACCESS_KEY = "secret";
	delete process.env.AWS_PROFILE;
	const model = { provider: "bedrock-mantle", api: "openai-responses", id: "x" } as any;
	let wireAt = 0;
	let amzDate = "";
	const wire = async (_input: any, init?: RequestInit) => {
		wireAt = Date.now();
		amzDate = new Headers(init?.headers).get("x-amz-date") ?? "";
		return new Response("{}", { status: 200 });
	};
	// Stand-in for `/pause` engaged after the chokepoint check: the hold parks 2.5s.
	const hold = () => Bun.sleep(2500);
	const held = transportFetch(model, wire as any, hold);
	const signed = createBedrockMantleAuthenticatedFetch({ fetch: held, providerOptions: { region: "us-east-1" } } as any);
	const t0 = Date.now();
	await signed("https://bedrock-mantle.us-east-1.api.aws/v1/responses", {
		method: "POST",
		body: JSON.stringify({ a: 1 }),
		headers: { "content-type": "application/json" },
	});
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate)!;
	const signedAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	console.log({ amzDate, signedAgeAtWireMs: wireAt - signedAt, holdMs: wireAt - t0 });
	expect(wireAt - signedAt).toBeGreaterThanOrEqual(2000);
});
