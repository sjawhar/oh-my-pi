import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { setCodexAttestationProvider } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/openai-codex-attestation";
import { streamSimple } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";
import type { AssistantMessage, FetchImpl, Model, ProviderSessionState, UserMessage } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/types";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";
import { getAgentDir, setAgentDir, TempDir } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/utils/src/index";

const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };
type Frame = Record<string, unknown>;

class PauseGate {
	#gate: PromiseWithResolvers<void> | undefined;
	get paused() { return this.#gate !== undefined; }
	pause() { this.#gate ??= Promise.withResolvers<void>(); }
	resume() { this.#gate?.resolve(); this.#gate = undefined; }
	hold = (): Promise<void> | void => this.#gate?.promise;
}

class FakeSocket {
	static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
	static instances: FakeSocket[] = [];
	static sent: Frame[] = [];
	readyState = FakeSocket.CONNECTING;
	binaryType = "nodebuffer";
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	onclose: ((e: CloseEvent) => void) | null = null;
	constructor() {
		FakeSocket.instances.push(this);
		queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.onopen?.(new Event("open")); });
	}
	send(data: string) {
		const frame = JSON.parse(data) as Frame;
		FakeSocket.sent.push(frame);
		if (frame.type === "response.create") {
			const id = `resp_${FakeSocket.sent.length}`;
			const item = { type: "message", id: `msg_${id}`, role: "assistant", content: [{ type: "output_text", text: "ok" }] };
			const frames = [
				{ type: "response.created", response: { id } },
				{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
				{ type: "response.output_text.delta", item_id: item.id, delta: "ok" },
				{ type: "response.output_item.done", item: { ...item, status: "completed" } },
				{ type: "response.completed", response: { id, status: "completed", usage: USAGE } },
			];
			queueMicrotask(() => { for (const f of frames) this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent); });
		}
	}
	close() { this.readyState = FakeSocket.CLOSED; }
	/** Server-side close (idle eviction / connection lifetime limit). */
	serverClose() {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.({ code: 1001, reason: "connection lifetime exceeded" } as CloseEvent);
	}
}

function createModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-6-sol", name: "GPT-6 Sol", api: "openai-codex-responses", provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api", reasoning: true, preferWebsockets: true, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000,
	});
}
function createToken(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }), "utf8").toBase64();
	return `aaa.${payload}.bbb`;
}
const nextTurn = () => new Promise<void>(r => setImmediate(r));

let sessions: Map<string, ProviderSessionState>;
beforeEach(() => {
	setAgentDir(TempDir.createSync("@pi-codex-probe-").path());
	sessions = new Map();
	FakeSocket.instances = []; FakeSocket.sent = [];
	global.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

it("control: same server close during request prep, no pause", async () => {
	const fetch = (async () => new Response("sse unavailable", { status: 503 })) as FetchImpl;
	const user: UserMessage = { role: "user", content: "hi", timestamp: 0 };
	const opts = () => ({ apiKey: createToken(), sessionId: "probe", providerSessionState: sessions, fetch });
	const r1 = await streamSimple(createModel(), { systemPrompt: ["s"], messages: [user] }, opts()).result();
	const release = Promise.withResolvers<void>();
	setCodexAttestationProvider(async () => { await release.promise; return undefined; });
	const msgs: (UserMessage | AssistantMessage)[] = [user, r1, { role: "user", content: "again", timestamp: 1 }];
	const t0 = Date.now();
	const p2 = streamSimple(createModel(), { systemPrompt: ["s"], messages: msgs }, opts()).result();
	for (let i = 0; i < 20; i++) await nextTurn();
	FakeSocket.instances[0]!.serverClose();
	release.resolve();
	const r2 = await Promise.race([p2, Bun.sleep(150000).then(() => undefined)]);
	console.log("control r2", r2?.stopReason, `${Date.now() - t0}ms`, { sockets: FakeSocket.instances.length, creates: FakeSocket.sent.filter(f => f.type === "response.create").length });
}, 200000);
afterEach(() => {
	for (const s of sessions.values()) s.close?.();
	setCodexAttestationProvider(undefined);
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

it("pause during request prep, server closes the reused socket during the held send", async () => {
	const gate = new PauseGate();
	let fetchCalls = 0;
	const fetch = (async () => { fetchCalls++; return new Response("sse unavailable", { status: 503 }); }) as FetchImpl;
	const user: UserMessage = { role: "user", content: "hi", timestamp: 0 };
	const opts = () => ({ apiKey: createToken(), sessionId: "probe", providerSessionState: sessions, beforeDispatch: gate.hold, fetch });
	const r1 = await streamSimple(createModel(), { systemPrompt: ["s"], messages: [user] }, opts()).result();
	console.log("r1", r1.stopReason, "sockets", FakeSocket.instances.length, "sent", FakeSocket.sent.length);

	let attest = 0;
	setCodexAttestationProvider(async () => { attest++; gate.pause(); return undefined; });
	const msgs: (UserMessage | AssistantMessage)[] = [user, r1, { role: "user", content: "again", timestamp: 1 }];
	const p2 = streamSimple(createModel(), { systemPrompt: ["s"], messages: msgs }, opts()).result();
	for (let i = 0; i < 20; i++) await nextTurn();
	console.log("held:", { paused: gate.paused, attest, sockets: FakeSocket.instances.length, sent: FakeSocket.sent.length });
	FakeSocket.instances[0]!.serverClose();
	for (let i = 0; i < 5; i++) await nextTurn();
	const t0 = Date.now();
	gate.resume();
	const r2 = await Promise.race([p2, Bun.sleep(150000).then(() => undefined)]);
	console.log("r2", r2?.stopReason, `${Date.now() - t0}ms after resume`, JSON.stringify(r2?.errorMessage)?.slice(0, 300));
	console.log("after:", { sockets: FakeSocket.instances.length, sentCreates: FakeSocket.sent.filter(f => f.type === "response.create").length, fetchCalls });
	expect(true).toBe(true);
}, 200000);
