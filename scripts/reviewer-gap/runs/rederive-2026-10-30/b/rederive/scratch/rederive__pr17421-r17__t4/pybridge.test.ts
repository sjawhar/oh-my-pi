import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
	unregisterPyToolBridgeSession,
} from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pybridge-probe-"));
fs.writeFileSync(path.join(dir, "1.bash.log"), "hello");

afterAll(async () => {
	await disposePyToolBridge();
	fs.rmSync(dir, { recursive: true, force: true });
});

// What prelude.py's _bridge_call sends from a thread a finished cell left running.
async function backgroundRead(info: { url: string; token: string }, session: string) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify({ session, run: "", name: "__artifacts_ready__", args: { id: "1", root: dir } }),
	});
	return await res.json();
}

test("background artifact read answered by whichever cell registered last", async () => {
	const info = await ensurePyToolBridge();
	const S = "sess-1";
	const toolSession = {} as never;

	// Cell A starts a background thread, then finishes normally.
	const a = new AbortController();
	const unA = registerPyToolBridge(S, "runA", {
		toolSession,
		signal: a.signal,
		shieldedSignal: a.signal,
		abortRequested: () => false,
	});
	unA();
	console.log("after cell A ended:", JSON.stringify(await backgroundRead(info, S)));

	// Cell B (unrelated) is interrupted by the user (Esc), then ends.
	const b = new AbortController();
	let bAbort = false;
	const unB = registerPyToolBridge(S, "runB", {
		toolSession,
		signal: b.signal,
		shieldedSignal: new AbortController().signal, // shield disposed at cell end, never aborted
		abortRequested: () => bAbort,
	});
	b.abort(new Error("user interrupt"));
	bAbort = true;
	unB();
	console.log("A's thread after cell B was interrupted:", JSON.stringify(await backgroundRead(info, S)));

	// Cell C in the same omp session, kernel for cwd X (session key = id+cwd+interpreter).
	const unC = registerPyToolBridge(S, "runC", { toolSession, abortRequested: () => false });
	unC();
	console.log("after cell C (kernel X) ended:", JSON.stringify(await backgroundRead(info, S)));
	// A different kernel of the same omp session (cwd Y) is shut down/reset:
	// shutdownInvalidatedSession(sessionY) -> unregisterPyToolBridgeSession(session.sessionId)
	unregisterPyToolBridgeSession(S);
	console.log("kernel X's thread after kernel Y shut down:", JSON.stringify(await backgroundRead(info, S)));
	expect(true).toBe(true);
});
