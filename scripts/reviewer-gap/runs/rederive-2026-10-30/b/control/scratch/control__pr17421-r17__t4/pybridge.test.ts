import { afterAll, expect, test } from "bun:test";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

afterAll(() => disposePyToolBridge());

async function post(info: { url: string; token: string }, body: unknown) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

test("stale run id is served by the newest cell's entry", async () => {
	const info = await ensurePyToolBridge();
	const calls: string[] = [];
	const mkEntry = (label: string) =>
		({
			toolSession: new Proxy({}, { get: (_t, p) => { calls.push(`${label}:${String(p)}`); return undefined; } }),
			signal: undefined,
			emitStatus: undefined,
		}) as never;
	const un1 = registerPyToolBridge("S", "run1", mkEntry("cell1"));
	un1(); // cell 1 finished
	const un2 = registerPyToolBridge("S", "run2", mkEntry("cell2"));
	un2(); // cell 2 finished too
	const noRun = await post(info, { session: "S", run: "", name: "bash", args: { command: "echo hi" } });
	console.log("no run      :", JSON.stringify(noRun));
	const stale = await post(info, { session: "S", run: "run1", name: "bash", args: { command: "echo hi" } });
	console.log("stale run1  :", JSON.stringify(stale));
	console.log("toolSession accesses:", [...new Set(calls)].slice(0, 8));
	expect(stale.body.error ?? "").not.toContain("No active Python tool bridge session");
});
