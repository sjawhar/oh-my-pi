import { afterAll, expect, test } from "bun:test";
import { disposePyToolBridge, ensurePyToolBridge, registerPyToolBridge } from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

afterAll(async () => {
	await disposePyToolBridge();
});

async function post(info: { url: string; token: string }, body: unknown) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return await res.json();
}

test("stale run id reaches newest cell's entry for any tool", async () => {
	const info = await ensurePyToolBridge();
	const calls: string[] = [];
	const mkSession = (tag: string) =>
		new Proxy({} as any, {
			get(_t, p) {
				calls.push(`${tag}:${String(p)}`);
				return undefined;
			},
		});
	const unregA = registerPyToolBridge("sid", "runA", { toolSession: mkSession("A") });
	unregA();
	registerPyToolBridge("sid", "runB", { toolSession: mkSession("B"), abortRequested: () => false });
	// Old cell's leftover thread still carries runA in its contextvar.
	const r = await post(info, { session: "sid", run: "runA", name: "bash", args: { command: "echo hi" } });
	console.log("stale runA bash ->", JSON.stringify(r).slice(0, 300));
	console.log("session props touched:", [...new Set(calls)].slice(0, 10));
	expect(String(r.error ?? "")).not.toContain("No active Python tool bridge session");
});

test("interrupted cell's standing entry rejects artifact reads after it ends", async () => {
	const info = await ensurePyToolBridge();
	const unreg = registerPyToolBridge("sid2", "runX", { toolSession: {} as any, abortRequested: () => true });
	unreg();
	const r = await post(info, { session: "sid2", run: "", name: "__artifacts_ready__", args: { id: "1", root: "/tmp/nonexistent-root" } });
	console.log("orphan readiness after interrupted cell ->", JSON.stringify(r));
});

test("per-call bridge ids stay answerable after unregister (leak)", async () => {
	const info = await ensurePyToolBridge();
	const unreg = registerPyToolBridge("py-bridge:deadbeef", "r1", { toolSession: {} as any });
	unreg();
	const r = await post(info, { session: "py-bridge:deadbeef", run: "", name: "__artifacts_ready__", args: { id: "1", root: "/tmp/nonexistent-root" } });
	console.log("per-call session after unregister ->", JSON.stringify(r));
});
