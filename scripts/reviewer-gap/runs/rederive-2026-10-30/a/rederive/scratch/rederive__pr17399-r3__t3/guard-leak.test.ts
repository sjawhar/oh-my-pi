import { test } from "bun:test";
import { armPreResponseTimeout } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/idle-iterator.ts";
import { transportFetch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/transport-fetch.ts";

test("hold that throws leaves the pre-response guard suspended and local work open", async () => {
	let settled = false;
	const heldWork = {
		trackLocalWork: (p: Promise<unknown>) => {
			p.then(() => {
				settled = true;
			});
			return p;
		},
	};
	const guard = armPreResponseTimeout(undefined, 50, heldWork as never);
	const model = { provider: "openai", api: "openai-responses", id: "x" } as never;
	const base = (async () => new Response("ok")) as never;
	const hold = () => {
		throw new Error("Session disposed before sharpshooter extraction was sent.");
	};
	const f = transportFetch(model, base, hold);
	let err = "";
	try {
		await f("http://127.0.0.1:1/v1/responses", { method: "POST", body: "{}", signal: guard.signal });
	} catch (e) {
		err = (e as Error).message;
	}
	await Bun.sleep(150);
	console.log(`fetch error=${JSON.stringify(err)} signal.aborted(after 150ms, budget 50ms)=${guard.signal?.aborted} localWorkSettled=${settled}`);
	guard.clear();
	await Bun.sleep(0);
	console.log(`after clear(): localWorkSettled=${settled}`);
});
