import { afterAll, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
	unregisterPyToolBridgeSession,
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
	return await res.json();
}

test("old kernel shutdown drops the replacement kernel's standing entry", async () => {
	const info = await ensurePyToolBridge();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-"));
	fs.writeFileSync(path.join(dir, "3.bash.log"), "hello");
	const toolSession = { getArtifactsDir: () => dir } as any;
	// new kernel's cell registered, then finished
	const u = registerPyToolBridge("sid-R", "run-new", { toolSession });
	u();
	const before = await post(info, { session: "sid-R", run: "", name: "__artifacts_ready__", args: { id: "3", root: dir } });
	// old kernel's shutdownInvalidatedSession runs (same sessionId)
	unregisterPyToolBridgeSession("sid-R");
	const after = await post(info, { session: "sid-R", run: "", name: "__artifacts_ready__", args: { id: "3", root: dir } });
	console.log("before old-kernel unregister:", JSON.stringify(before));
	console.log("after  old-kernel unregister:", JSON.stringify(after));
});
