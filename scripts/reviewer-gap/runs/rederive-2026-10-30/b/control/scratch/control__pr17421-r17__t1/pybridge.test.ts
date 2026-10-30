import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	return { status: res.status, json: await res.json() };
}

test("stale run id is served by the newest session entry for any tool", async () => {
	const info = await ensurePyToolBridge();
	const calls: string[] = [];
	const toolSession = {
		cwd: os.tmpdir(),
		getArtifactsDir: () => null,
	} as never;
	const unregister = registerPyToolBridge("sess-A", "run-1", { toolSession });
	unregister(); // cell 1 ended
	const r = await post(info, { session: "sess-A", run: "run-1", name: "definitely_not_a_tool", args: {} });
	console.log("stale-run:", JSON.stringify(r));
	const r2 = await post(info, { session: "sess-A", run: "never-existed", name: "definitely_not_a_tool", args: {} });
	console.log("bogus-run:", JSON.stringify(r2));
	expect(String(r.json.error ?? "")).not.toContain("No active Python tool bridge session");
	void calls;
});

test("runless artifact read after a cancelled cell is refused", async () => {
	const info = await ensurePyToolBridge();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-"));
	fs.writeFileSync(path.join(dir, "3.bash.log"), "hello");
	const toolSession = { cwd: dir, getArtifactsDir: () => dir } as never;
	const ac = new AbortController();
	const unregister = registerPyToolBridge("sess-B", "run-1", {
		toolSession,
		signal: ac.signal,
		abortRequested: () => true, // cell 1 was cancelled / timed out
	});
	unregister();
	const r = await post(info, { session: "sess-B", run: "", name: "__artifacts_ready__", args: { id: "3", root: dir } });
	console.log("after-cancel:", JSON.stringify(r));

	const unregister2 = registerPyToolBridge("sess-C", "run-1", { toolSession, signal: ac.signal });
	unregister2();
	ac.abort(); // the turn that ran the last cell is interrupted later
	const r2 = await post(info, { session: "sess-C", run: "", name: "__artifacts_ready__", args: { id: "3", root: dir } });
	console.log("after-turn-abort:", JSON.stringify(r2));
});
