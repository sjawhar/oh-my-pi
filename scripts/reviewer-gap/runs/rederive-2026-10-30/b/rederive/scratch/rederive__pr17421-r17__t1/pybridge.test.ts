import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
	unregisterPyToolBridgeSession,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

const calls: string[] = [];
function toolSession(label: string): any {
	const tool = {
		name: "echo",
		label: "echo",
		description: "echo",
		parameters: { type: "object", properties: {}, additionalProperties: true },
		async execute() {
			calls.push(label);
			return { content: [{ type: "text", text: `ran in ${label}` }] };
		},
	};
	return { cwd: os.tmpdir(), getToolByName: (n: string) => (n === "echo" ? tool : undefined) };
}

async function post(session: string, run: string, name: string, args: unknown = {}) {
	const info = await ensurePyToolBridge();
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify({ session, run, name, args }),
	});
	return await res.json();
}

afterAll(() => disposePyToolBridge());

test("stale run id after its cell ended: any tool still served", async () => {
	const s = `s-${crypto.randomUUID()}`;
	const unregA = registerPyToolBridge(s, "runA", { toolSession: toolSession("cellA") });
	unregA(); // cell A finished
	const r = await post(s, "runA", "echo");
	console.log("ended-cell call:", JSON.stringify(r), "calls:", calls);
});

test("stale run id from cell A while cell B runs: served under B's entry", async () => {
	const s = `s-${crypto.randomUUID()}`;
	calls.length = 0;
	const unregA = registerPyToolBridge(s, "runA", { toolSession: toolSession("cellA") });
	unregA();
	const unregB = registerPyToolBridge(s, "runB", { toolSession: toolSession("cellB") });
	const r = await post(s, "runA", "echo");
	console.log("cross-cell call:", JSON.stringify(r), "calls:", calls);
	unregB();
});

test("newest cell aborted: run-less artifact read from a background thread refused", async () => {
	const s = `s-${crypto.randomUUID()}`;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arts-"));
	fs.writeFileSync(path.join(dir, "3.bash.log"), "hello");
	const unregA = registerPyToolBridge(s, "runA", { toolSession: toolSession("cellA") });
	unregA();
	const okBefore = await post(s, "", "__artifacts_ready__", { id: "3", root: dir });
	console.log("bg read, cell A ended normally:", JSON.stringify(okBefore));
	const ac = new AbortController();
	ac.abort();
	const unregB = registerPyToolBridge(s, "runB", { toolSession: toolSession("cellB"), signal: ac.signal });
	unregB(); // cell B was cancelled and is gone
	const r = await post(s, "", "__artifacts_ready__", { id: "3", root: dir });
	console.log("bg read after unrelated cell B cancelled:", JSON.stringify(r));
});

test("another kernel of the same omp session shutting down drops this kernel's standing entry", async () => {
	const s = `s-${crypto.randomUUID()}`;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arts-"));
	fs.writeFileSync(path.join(dir, "3.bash.log"), "hello");
	// kernel at cwd A ran a cell, left a thread
	registerPyToolBridge(s, "runA", { toolSession: toolSession("kernelA") })();
	// kernel at cwd B of the same session (same bridge session id) is invalidated
	unregisterPyToolBridgeSession(s);
	const r = await post(s, "", "__artifacts_ready__", { id: "3", root: dir });
	console.log("kernel A bg read after kernel B shutdown:", JSON.stringify(r));
});
