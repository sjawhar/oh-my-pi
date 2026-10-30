import { afterAll, expect, test } from "bun:test";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
	unregisterPyToolBridgeSession,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

const calls: Array<{ cell: string; args: unknown }> = [];
function fakeSession(cell: string): any {
	const tool = {
		name: "probe_side_effect",
		label: "probe",
		description: "probe",
		parameters: { type: "object", properties: { cmd: { type: "string" } } },
		async execute(_id: string, params: unknown) {
			calls.push({ cell, args: params });
			return { content: [{ type: "text", text: `ran in ${cell}` }] };
		},
	};
	return {
		cwd: process.cwd(),
		getToolByName: (n: string) => (n === tool.name ? tool : undefined),
	};
}

async function post(info: { url: string; token: string }, body: unknown) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return await res.json();
}

afterAll(async () => {
	await disposePyToolBridge();
});

test("stale run id after its cell unregistered", async () => {
	const info = await ensurePyToolBridge();
	const sid = "probe-session";
	// Cell A runs and finishes.
	const unregisterA = registerPyToolBridge(sid, "runA", { toolSession: fakeSession("A") } as any);
	unregisterA();
	// An asyncio task cell A left running still carries runA in its contextvar.
	const staleAfterA = await post(info, { session: sid, run: "runA", name: "probe_side_effect", args: { cmd: "rm -rf x" } });
	console.log("stale runA, no cell active:", JSON.stringify(staleAfterA));
	// Cell B starts.
	const unregisterB = registerPyToolBridge(sid, "runB", { toolSession: fakeSession("B") } as any);
	const staleDuringB = await post(info, { session: sid, run: "runA", name: "probe_side_effect", args: { cmd: "x" } });
	console.log("stale runA while cell B active:", JSON.stringify(staleDuringB));
	const forged = await post(info, { session: sid, run: "made-up", name: "probe_side_effect", args: { cmd: "y" } });
	console.log("made-up run id:", JSON.stringify(forged));
	unregisterB();
	console.log("tool executions:", JSON.stringify(calls));
});

test("per-call/dispose retention", async () => {
	const info = await ensurePyToolBridge();
	// per-call mode: each call is a fresh py-bridge:<uuid> and never calls unregisterPyToolBridgeSession
	const sid = `py-bridge:${crypto.randomUUID()}`;
	registerPyToolBridge(sid, "r1", { toolSession: fakeSession("percall") } as any)();
	const afterUnregister = await post(info, { session: sid, run: "r1", name: "probe_side_effect", args: {} });
	console.log("per-call session after its only run unregistered:", JSON.stringify(afterUnregister));
	await disposePyToolBridge();
	const info2 = await ensurePyToolBridge();
	const afterDispose = await post(info2, { session: sid, run: "r1", name: "probe_side_effect", args: {} });
	console.log("after disposePyToolBridge:", JSON.stringify(afterDispose));
	void unregisterPyToolBridgeSession;
});
