import { afterAll, expect, test } from "bun:test";
import { agentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause";
import {
	buildCompactionV2Request,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/compaction/openai";
import type { FetchImpl, Model } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types";
import { NO_AUTH_SENTINEL } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/auth-retry";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";

Object.assign(process.env, {
	AWS_REGION: "us-west-2",
	AWS_CONFIG_FILE: "/nonexistent/aws-config",
	AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/aws-credentials",
	AWS_EC2_METADATA_DISABLED: "true",
	AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1/creds",
});
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_PROFILE;

const model = buildModel({
	id: "openai.gpt-6-sol",
	name: "mantle",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
}) as Model<"openai-responses">;

afterAll(() => agentPauseGate.resume());

function makeFetch(log: string[]): FetchImpl {
	return async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/creds")) {
			// The credential lookup is the window between the compaction's hold and its send.
			agentPauseGate.pause();
			log.push(`creds lookup; pause engaged -> paused=${agentPauseGate.paused}`);
			return Response.json({
				AccessKeyId: "AKIDEXAMPLE",
				SecretAccessKey: "secret",
				Token: "tok",
				Expiration: new Date(Date.now() + 3600_000).toISOString(),
			});
		}
		log.push(`${init?.method ?? "GET"} ${url} sent while paused=${agentPauseGate.paused}`);
		if (url.endsWith("/responses/compact")) return Response.json({ output: [{ type: "compaction", encrypted_content: "enc" }] });
		const body = [
			{ type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "enc" } },
			{ type: "response.completed" },
		]
			.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			.join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
}

test("V1 remote compaction on Bedrock Mantle (SigV4): pause engaged during credential lookup", async () => {
	const log: string[] = [];
	const ac = new AbortController();
	const pending = requestOpenAiRemoteCompaction(
		model,
		NO_AUTH_SENTINEL,
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
		ac.signal,
		{ fetch: makeFetch(log), beforeDispatch: agentPauseGate.dispatchHold(ac.signal) },
	);
	const outcome = await Promise.race([
		pending.then(() => "completed"),
		Bun.sleep(500).then(() => "still held after 500ms"),
	]);
	console.log("V1:", outcome, "\n  " + log.join("\n  "));
	agentPauseGate.resume();
	await pending.catch(() => {});
	expect(log.some(l => l.includes("sent while paused=true"))).toBe(false);
});

test("V2 streaming compaction on Bedrock Mantle (SigV4): pause engaged during credential lookup", async () => {
	const { invalidateAwsCredentialCache } = await import(
		"/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/aws-credentials"
	);
	invalidateAwsCredentialCache({ region: "us-west-2" });
	const log: string[] = [];
	const ac = new AbortController();
	const request = buildCompactionV2Request(
		model,
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
	);
	const pending = requestCompactionV2Streaming(model, NO_AUTH_SENTINEL, request, ac.signal, {
		fetch: makeFetch(log),
		beforeDispatch: agentPauseGate.dispatchHold(ac.signal),
	});
	const outcome = await Promise.race([
		pending.then(() => "completed"),
		Bun.sleep(500).then(() => "still held after 500ms"),
	]);
	console.log("V2:", outcome, "\n  " + log.join("\n  "));
	agentPauseGate.resume();
	await pending.catch(() => {});
	expect(log.some(l => l.includes("sent while paused=true"))).toBe(false);
});
