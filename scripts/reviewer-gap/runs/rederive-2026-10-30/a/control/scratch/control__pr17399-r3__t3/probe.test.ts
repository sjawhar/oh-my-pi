import { expect, test } from "bun:test";
import { holdAllBeforeDispatch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/dispatch-hold";
import { armPreResponseTimeout, preResponseGuard } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/idle-iterator";
import { AssistantMessageEventStream } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/event-stream";
import { transportFetch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/transport-fetch";

const model = { provider: "openai", api: "openai-responses", id: "x", baseUrl: "http://127.0.0.1:1" } as any;

test("second hold that awaits I/O on an OPEN gate fails the request", async () => {
	const open = () => {};
	// agent-loop shape: async () => { await config.beforeDispatch?.(); ... } where the
	// caller's hook does one short timer/I/O await, gate open.
	const ioHold = async () => {
		await new Promise(r => setTimeout(r, 1));
	};
	let err: unknown;
	try {
		await holdAllBeforeDispatch([open, ioHold]);
	} catch (e) {
		err = e;
	}
	console.log("holdAll result:", err instanceof Error ? err.message : "ok");
});

test("transport fetch: hold throws -> heldWork window stays open, guard stays suspended", async () => {
	const stream = new AssistantMessageEventStream();
	const guard = armPreResponseTimeout(undefined, 50, stream);
	const throwing = () => {
		throw new Error("session changed");
	};
	const f = transportFetch(model, (async () => new Response("ok")) as any, throwing);
	let err: unknown;
	try {
		await f("http://127.0.0.1:1/x", { method: "POST", signal: guard.signal });
	} catch (e) {
		err = e;
	}
	console.log("fetch err:", (err as Error)?.message, "pendingLocalWork:", stream.hasPendingLocalWork);
	await Bun.sleep(120);
	console.log("after 120ms (budget 50): signal aborted?", guard.signal?.aborted, "pendingLocalWork:", stream.hasPendingLocalWork);
	guard.clear();
	console.log("after clear pendingLocalWork:", stream.hasPendingLocalWork);
});

test("concurrent attempts sharing one guard: second hold's time is counted", async () => {
	const guard = armPreResponseTimeout(undefined, 100);
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	let n = 0;
	const hold = () => (n++ === 0 ? undefined : gate);
	const f = transportFetch(model, (async () => new Response("ok")) as any, hold);
	await f("http://127.0.0.1:1/a", { method: "POST", signal: guard.signal });
	// first attempt went out and resumed the clock; second parks on the hold
	const p = f("http://127.0.0.1:1/b", { method: "POST", signal: guard.signal }).catch(e => e);
	await Bun.sleep(200);
	console.log("held 200ms on a 100ms budget, aborted?", guard.signal?.aborted);
	release();
	const r = await p;
	console.log("second:", r instanceof Response ? r.status : String(r));
});
