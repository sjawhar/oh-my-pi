import { afterEach, expect, test } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { clearCustomApis, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { armPreResponseTimeout } from "@oh-my-pi/pi-ai/utils/idle-iterator";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";

const SRC = "probe-src";
const API = "probe-api" as Api;
const model = { id: "m", name: "m", api: API, provider: "probe", contextWindow: 1000, maxTokens: 100 } as Model<Api>;
const ctx: Context = { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };

afterEach(() => {
	agentPauseGate.resume();
	unregisterCustomApis(SRC);
	clearCustomApis();
});

test("credential resolved before /pause is the one dispatched after resume", async () => {
	const wire: unknown[] = [];
	registerCustomApi(
		API,
		(_m: Model<Api>, _c: Context, o?: SimpleStreamOptions) => {
			wire.push(o?.apiKey);
			const s = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const msg = { role: "assistant", content: [{ type: "text", text: "ok" }], api: API, provider: "probe", model: "m", timestamp: 1, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never;
				s.push({ type: "start", partial: msg });
				s.push({ type: "done", reason: "stop", message: msg });
			});
			return s;
		},
		SRC,
	);
	let tokenVersion = 1;
	const resolverCalls: string[] = [];
	agentPauseGate.pause();
	const run = streamSimple(model, ctx, {
		apiKey: async () => {
			const t = `oauth-token-v${tokenVersion}`;
			resolverCalls.push(t);
			return t;
		},
		beforeDispatch: agentPauseGate.dispatchHold(),
	}).result();
	await Bun.sleep(20);
	console.log("during pause: resolverCalls=", resolverCalls, "wire=", wire);
	tokenVersion = 2; // token refreshed/expired while the human kept /pause engaged
	agentPauseGate.resume();
	await run;
	console.log("after resume: resolverCalls=", resolverCalls, "wire=", wire);
});

test("two fetches sharing one pre-response guard: held B's budget runs once A resumes", async () => {
	const guard = armPreResponseTimeout(undefined, 100);
	let aSent = false;
	const base = async (_i: string | URL | Request, init?: RequestInit) => {
		aSent = true;
		return await new Promise<Response>((resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
			setTimeout(() => resolve(new Response("ok")), 1000);
		});
	};
	let releaseB!: () => void;
	const holdB = new Promise<void>(r => (releaseB = r));
	let first = true;
	const hold = () => {
		if (first) {
			first = false;
			return;
		}
		return holdB;
	};
	const f = transportFetch(model, base as never, hold);
	const t0 = Date.now();
	const a = f("http://x/a", { method: "POST", signal: guard.signal }).then(
		() => "A ok",
		e => `A ${e?.name}@${Date.now() - t0}ms`,
	);
	const b = f("http://x/b", { method: "POST", signal: guard.signal }).then(
		() => "B ok",
		e => `B ${e?.name}@${Date.now() - t0}ms`,
	);
	await Bun.sleep(300);
	console.log("B still held; guard aborted?", guard.signal!.aborted, "reason", (guard.signal!.reason as Error)?.name, "aSent", aSent);
	releaseB();
	console.log(await a, "|", await b);
	guard.clear();
});
