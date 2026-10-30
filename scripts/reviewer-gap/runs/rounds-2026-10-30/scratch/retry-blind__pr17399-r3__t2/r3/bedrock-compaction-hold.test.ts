import { expect, spyOn, test } from "bun:test";
import {
	buildCompactionV2Request,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
} from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/compaction/openai.ts";
import { NO_AUTH_SENTINEL } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/auth-retry.ts";
import * as awsCreds from "/mnt/nvme/astra17399-r3/head/packages/ai/src/providers/aws-credentials.ts";
import type { FetchImpl } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types.ts";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build.ts";

const model = buildModel({
	id: "openai.gpt-6-sol",
	name: "mantle",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

function setup() {
	Bun.env.AWS_REGION = "us-west-2";
	delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
	const gate = { closed: false };
	const resumed = Promise.withResolvers<void>();
	const log: string[] = [];
	// Credential lookup takes a while (SSO / process / IMDS); /pause lands during it.
	const spy = spyOn(awsCreds, "resolveAwsCredentials").mockImplementation((async () => {
		log.push("creds:start");
		await Bun.sleep(20);
		gate.closed = true; // user hits /pause here
		log.push("pause engaged");
		return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
	}) as never);
	const hold = () => {
		log.push(`hold asked (closed=${gate.closed})`);
		return gate.closed ? resumed.promise : undefined;
	};
	return { gate, resumed, log, spy, hold };
}

test("V1 Bedrock remote compaction: POST while gate closed?", async () => {
	const { gate, resumed, log, spy, hold } = setup();
	const fetchMock: FetchImpl = async input => {
		log.push(`WIRE ${String(input)} sentWhilePaused=${gate.closed}`);
		return Response.json({ output: [{ type: "compaction", encrypted_content: "enc" }] });
	};
	const p = requestOpenAiRemoteCompaction(model, NO_AUTH_SENTINEL, input, "instr", undefined, {
		fetch: fetchMock,
		beforeDispatch: hold,
	});
	await Bun.sleep(100);
	log.push("--- 100ms later, gate still closed; resuming");
	gate.closed = false;
	resumed.resolve();
	await p.catch(e => log.push(`error ${e}`));
	spy.mockRestore();
	console.log(log.join("\n"));
});

test("V2 Bedrock streaming compaction: POST while gate closed?", async () => {
	const { gate, resumed, log, spy, hold } = setup();
	const fetchMock: FetchImpl = async input => {
		log.push(`WIRE ${String(input)} sentWhilePaused=${gate.closed}`);
		const body = [
			`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "enc" } })}\n\n`,
			`data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
		].join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	const request = buildCompactionV2Request(model, input, "instr");
	const p = requestCompactionV2Streaming(model, NO_AUTH_SENTINEL, request, undefined, {
		fetch: fetchMock,
		beforeDispatch: hold,
	});
	await Bun.sleep(100);
	log.push("--- 100ms later, gate still closed; resuming");
	gate.closed = false;
	resumed.resolve();
	await p.catch(e => log.push(`error ${e}`));
	spy.mockRestore();
	console.log(log.join("\n"));
});
