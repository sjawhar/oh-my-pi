import { expect, it } from "bun:test";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";
import { requestCompactionV2Streaming } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/compaction/compaction-v2-streaming";

type Frame = Record<string, unknown>;
const CONTROL = process.env.CONTROL === "1";
const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 500);
const t0 = Date.now();
const log = (m: string) => console.log(`[+${Date.now() - t0}ms] ${m}`);

class FakeSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSING = 2;
	static CLOSED = 3;
	static sent: Frame[] = [];
	readyState = 0;
	binaryType = "nodebuffer";
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	onclose: ((e: CloseEvent) => void) | null = null;
	constructor() {
		log("ws connect");
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.(new Event("open"));
		});
	}
	send(data: string) {
		const f = JSON.parse(data) as Frame;
		FakeSocket.sent.push(f);
		log(`ws send ${f.type}`);
	}
	close() {
		this.readyState = 3;
	}
}
global.WebSocket = FakeSocket as unknown as typeof WebSocket;

function token(): string {
	const p = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } })).toBase64();
	return `aaa.${p}.bbb`;
}

it("v2 codex compaction: a /pause engaged after the outer hold runs the attempt timeout", async () => {
	const model = buildModel({
		id: "gpt-6-sol",
		name: "x",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
	let gate: PromiseWithResolvers<void> | undefined;
	let calls = 0;
	const hold = () => {
		calls++;
		if (calls === 1 && !CONTROL) {
			// The outer hold at compaction-v2-streaming.ts:325 passes; the user pauses right after.
			queueMicrotask(() => {
				gate = Promise.withResolvers<void>();
				log("pause engaged");
				setTimeout(() => {
					log("resume");
					gate?.resolve();
					gate = undefined;
				}, 1500);
			});
			return;
		}
		if (calls === 1) {
			log("hold call #1 (control: no pause)");
			return;
		}
		log(`hold call #${calls} paused=${gate !== undefined}`);
		return gate?.promise;
	};
	let outcome: string;
	try {
		await requestCompactionV2Streaming(
			model,
			token(),
			{ body: { model: "gpt-6-sol" }, input: [], retainedUserItems: [], retainedMessageBudget: 10 } as never,
			undefined,
			{ timeoutMs: TIMEOUT, beforeDispatch: hold, preferWebsockets: true, retryWait: async () => {},
				fetch: (async () => { throw new Error("SSE fallback"); }) as never },
		);
		outcome = "resolved";
	} catch (e) {
		outcome = `rejected: ${(e as Error).name}: ${(e as Error).message}`;
	}
	log(outcome);
	log(`frames sent: ${JSON.stringify(FakeSocket.sent.map(f => f.type))}`);
	expect(true).toBe(true);
}, 20_000);
