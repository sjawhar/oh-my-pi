import { afterAll, expect, test } from "bun:test";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

afterAll(async () => {
	await disposePyToolBridge();
});

async function post(info: { url: string; token: string }, body: unknown) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

test("stale run after cell end", async () => {
	const info = await ensurePyToolBridge();
	const calls: string[] = [];
	const toolSession = new Proxy(
		{},
		{
			get(_t, prop) {
				calls.push(String(prop));
				return undefined;
			},
		},
	) as any;
	const ctrl = new AbortController();
	const unregister = registerPyToolBridge("sid-A", "run-1", { toolSession, signal: ctrl.signal });
	unregister(); // cell ended
	const stale = await post(info, { session: "sid-A", run: "run-1", name: "bash", args: { command: "echo pwned" } });
	console.log("stale run-1 after unregister ->", JSON.stringify(stale), "toolSession touched:", calls.slice(0, 8));
	const forged = await post(info, { session: "sid-A", run: "any-made-up-run", name: "write", args: { path: "/tmp/x", content: "y" } });
	console.log("made-up run ->", JSON.stringify(forged));

	// Cancelled newest cell poisons artifact reads from background threads
	let aborted = false;
	const u2 = registerPyToolBridge("sid-B", "run-2", { toolSession, abortRequested: () => aborted });
	aborted = true;
	u2();
	const art = await post(info, { session: "sid-B", run: "", name: "__artifacts_ready__", args: { id: "1", root: "/tmp" } });
	console.log("artifacts_ready after cancelled newest cell ->", JSON.stringify(art));
});
