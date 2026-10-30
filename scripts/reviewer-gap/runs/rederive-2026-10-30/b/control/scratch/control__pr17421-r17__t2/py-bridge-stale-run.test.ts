import { afterAll, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";
import type { ToolSession } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/tools";

function makeTool(name: string, calls: string[]): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute(id: string): Promise<AgentToolResult> {
			calls.push(id);
			return { content: [{ type: "text", text: "RAN" }] };
		},
	} as unknown as AgentTool;
}

afterAll(async () => {
	await disposePyToolBridge();
});

it("call from an ended run with any tool name", async () => {
	const calls: string[] = [];
	const session = { getToolByName: (n: string) => (n === "bash" ? makeTool("bash", calls) : undefined) } as unknown as ToolSession;
	const info = await ensurePyToolBridge();
	const unregister = registerPyToolBridge("sess-A", "run-1", { toolSession: session });
	unregister(); // cell ended
	const post = (body: unknown) =>
		fetch(`${info.url}/v1/tool`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}` },
			body: JSON.stringify(body),
		}).then(r => r.json());
	const stale = await post({ session: "sess-A", run: "run-1", name: "bash", args: {} });
	const forged = await post({ session: "sess-A", run: "anything", name: "bash", args: {} });
	const empty = await post({ session: "sess-A", run: "", name: "bash", args: {} });
	console.log(JSON.stringify({ stale, forged, empty, calls: calls.length }));
	expect(stale.ok).toBe(false);
});
