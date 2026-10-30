import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const SRC = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src";
const { Settings } = await import(`${SRC}/config/settings`);
type ToolSession = any;
const { disposePyToolBridge, ensurePyToolBridge, registerPyToolBridge } = await import(`${SRC}/eval/py/tool-bridge`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pybridge-"));
const artifactsDir = path.join(tmp, "artifacts");
fs.mkdirSync(artifactsDir);
fs.writeFileSync(path.join(artifactsDir, "3.bash.log"), "inherited output\n");
fs.writeFileSync(path.join(tmp, "secret.txt"), "contents of secret.txt\n");

function toolSession(): ToolSession {
	return {
		cwd: tmp,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		settings: Settings.isolated(),
		localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "s" },
	} as ToolSession;
}

async function post(body: unknown) {
	const info = await ensurePyToolBridge();
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return await res.json();
}

afterAll(async () => {
	await disposePyToolBridge();
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("stale run id: a tool call from a cell that already ended", async () => {
	const calls: string[] = [];
	const sessionWithTool = (label: string) => ({
		...toolSession(),
		getToolByName: (name: string) =>
			name === "write"
				? {
						name: "write",
						description: "w",
						parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
						execute: async (_id: string, args: unknown) => {
							calls.push(`${label} session executed write ${JSON.stringify(args)}`);
							return { content: [{ type: "text", text: "wrote" }] };
						},
					}
				: undefined,
	});
	const unregisterA = registerPyToolBridge("S1", "run-A", { toolSession: sessionWithTool("cell-A") });
	unregisterA(); // cell A ended; an asyncio task it spawned still carries run-A in its context
	registerPyToolBridge("S1", "run-B", { toolSession: sessionWithTool("cell-B") })(); // cell B ran and ended
	const reply = await post({ session: "S1", run: "run-A", name: "write", args: { path: "x", content: "late" } });
	console.log("stale run-A write reply:", JSON.stringify(reply).slice(0, 300));
	console.log("calls:", calls);
});

test("background readiness read after the newest cell was interrupted", async () => {
	// Cell A (healthy) then cell B, which the user interrupted.
	registerPyToolBridge("S2", "run-A", { toolSession: toolSession() })();
	let bAborted = false;
	const unregisterB = registerPyToolBridge("S2", "run-B", {
		toolSession: toolSession(),
		abortRequested: () => bAborted,
	});
	bAborted = true; // user pressed Esc in cell B
	unregisterB();
	// A thread left running by cell A asks for artifact://3 with no run.
	const reply = await post({ session: "S2", run: "", name: "__artifacts_ready__", args: { id: "3", root: artifactsDir } });
	console.log("thread-from-A readiness reply:", JSON.stringify(reply));
});
