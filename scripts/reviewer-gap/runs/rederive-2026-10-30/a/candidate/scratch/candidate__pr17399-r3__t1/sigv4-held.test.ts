import { afterAll, expect, setSystemTime, test } from "bun:test";
import { agentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause";
import { createBedrockMantleAuthenticatedFetch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/bedrock-mantle";
import { transportFetch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/transport-fetch";

process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
delete process.env.AWS_PROFILE;
delete process.env.AWS_BEARER_TOKEN_BEDROCK;

afterAll(() => setSystemTime());

function amzDateToMs(v: string): number {
	// 20261030T120000Z
	const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`;
	return Date.parse(iso);
}

test("SigV4 signed before /pause hold, sent after resume", async () => {
	const t0 = Date.parse("2026-10-30T12:00:00Z");
	setSystemTime(new Date(t0));
	const model = { provider: "bedrock-mantle", api: "openai-responses", id: "m" } as never;
	let wire: { amzDate: string; sentAt: number } | undefined;
	const base = async (_input: string | URL | Request, init?: RequestInit) => {
		const h = new Headers(init?.headers);
		wire = { amzDate: h.get("x-amz-date") ?? "", sentAt: Date.now() };
		return new Response("{}", { status: 200 });
	};
	const held = transportFetch(model, base, agentPauseGate.dispatchHold());
	const signed = createBedrockMantleAuthenticatedFetch({
		fetch: held,
		providerOptions: { region: "us-east-1" },
	} as never);

	agentPauseGate.pause();
	const p = signed("https://bedrock-mantle.us-east-1.api.aws/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	await Bun.sleep(20);
	console.log("sent while paused:", wire !== undefined);
	// Human comes back 20 minutes later.
	setSystemTime(new Date(t0 + 20 * 60_000));
	agentPauseGate.resume();
	await p;
	const signedAt = amzDateToMs(wire!.amzDate);
	console.log("x-amz-date:", wire!.amzDate, "sent at:", new Date(wire!.sentAt).toISOString());
	console.log("signature age at wire (s):", (wire!.sentAt - signedAt) / 1000);
	expect(wire!.sentAt - signedAt).toBeLessThan(15 * 60_000);
});
