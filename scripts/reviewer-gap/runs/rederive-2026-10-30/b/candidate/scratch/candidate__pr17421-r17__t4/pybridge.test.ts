import { afterAll, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge.ts";
type ToolSession = any;

function tool(name: string, calls: { session: string; signal?: AbortSignal }[], label: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute(_id: string, _args: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
			calls.push({ session: label, signal });
			return { content: [{ type: "text", text: `ran under ${label}` }] };
		},
	} as unknown as AgentTool;
}
const sess = (t: AgentTool) => ({ getToolByName: (n: string) => (n === t.name ? t : undefined) }) as unknown as ToolSession;

async function post(info: { url: string; token: string }, body: unknown) {
	const r = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}` },
		body: JSON.stringify(body),
	});
	return await r.json();
}

afterAll(async () => {
	await disposePyToolBridge();
});

it("stale-run call after its cell ended", async () => {
	const info = await ensurePyToolBridge();
	const calls: { session: string; signal?: AbortSignal }[] = [];
	const S = `s-${crypto.randomUUID()}`;
	const acA = new AbortController();
	const unA = registerPyToolBridge(S, "runA", { toolSession: sess(tool("write", calls, "cellA")), signal: acA.signal });
	unA(); // cell A finished
	const r1 = await post(info, { session: S, run: "runA", name: "write", args: {} });
	console.log("after A ended, no other cell:", JSON.stringify(r1), "calls=", calls.length);

	const acB = new AbortController();
	const unB = registerPyToolBridge(S, "runB", { toolSession: sess(tool("write", calls, "cellB")), signal: acB.signal });
	const r2 = await post(info, { session: S, run: "runA", name: "write", args: {} });
	console.log("A's thread while B runs:", JSON.stringify(r2), "last call signal is B's:", calls.at(-1)?.signal === acB.signal);
	unB();
	acB.abort();
	const r3 = await post(info, { session: S, run: "runA", name: "write", args: {} });
	console.log("after B aborted:", JSON.stringify(r3));
	await disposePyToolBridge();
	const S2 = `py-bridge:${crypto.randomUUID()}`;
	const un = registerPyToolBridge(S2, "run1", { toolSession: sess(tool("write", calls, "percall")) });
	un(); // per-call run finished; executePerCall then calls kernel.shutdown() directly
	await disposePyToolBridge();
	const info3 = await ensurePyToolBridge();
	const r4 = await post(info3, { session: S2, run: "run1", name: "write", args: {} });
	console.log("per-call entry after unregister + disposePyToolBridge:", JSON.stringify(r4));
	expect(true).toBe(true);
});
