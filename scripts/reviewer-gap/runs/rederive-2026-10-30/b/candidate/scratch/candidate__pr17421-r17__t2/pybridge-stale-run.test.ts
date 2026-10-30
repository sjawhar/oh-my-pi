import { afterAll, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function tool(name: string, log: string[]): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute(_id: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
			log.push(`${name} ran args=${JSON.stringify(args)} signalAborted=${signal?.aborted}`);
			return { content: [{ type: "text", text: `${name}-done` }] };
		},
	} as unknown as AgentTool;
}
const session = (tools: Record<string, AgentTool>) =>
	({ getToolByName: (n: string) => tools[n] }) as unknown as ToolSession;

async function post(info: { url: string; token: string }, body: unknown) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}` },
		body: JSON.stringify(body),
	});
	return await res.json();
}

afterAll(async () => {
	await disposePyToolBridge();
});

it("stale run id after its cell ended", async () => {
	const info = await ensurePyToolBridge();
	const logA: string[] = [];
	const logB: string[] = [];
	// Cell A runs and ends.
	const unA = registerPyToolBridge("kernel-1", "run-A", { toolSession: session({ bash: tool("bash", logA) }) });
	unA();
	// A background thread from cell A, after A ended, calls bash with A's run id.
	const r1 = await post(info, { session: "kernel-1", run: "run-A", name: "bash", args: { command: "rm -rf x" } });
	console.log("after A ended, no cell running:", JSON.stringify(r1), logA);

	// Cell B starts with its own entry; user then cancels B.
	const ctlB = new AbortController();
	const unB = registerPyToolBridge("kernel-1", "run-B", {
		toolSession: session({ bash: tool("bash", logB) }),
		signal: ctlB.signal,
	});
	unB();
	const r2 = await post(info, { session: "kernel-1", run: "run-A", name: "bash", args: { command: "echo from-A" } });
	console.log("cell A thread after B ended:", JSON.stringify(r2), "logB=", logB);
});
