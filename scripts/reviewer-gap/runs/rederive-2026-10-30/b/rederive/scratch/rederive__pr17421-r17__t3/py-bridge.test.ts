import { afterAll, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/tool-bridge";

afterAll(() => disposePyToolBridge());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pybridge-"));
fs.writeFileSync(path.join(dir, "1.bash.log"), "hello");

async function post(info: { url: string; token: string }, body: unknown) {
	const res = await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return await res.json();
}

function stubSession(label: string) {
	return {
		cwd: dir,
		label,
		getArtifactsDir: () => dir,
	} as never;
}

it("background artifact read after the newest cell was interrupted", async () => {
	const info = await ensurePyToolBridge();
	const statusA: unknown[] = [];
	const statusB: unknown[] = [];
	// Cell A starts a thread, then ends.
	const unregA = registerPyToolBridge("S", "A", {
		toolSession: stubSession("A"),
		emitStatus: e => statusA.push(e),
	});
	unregA();
	// Cell B runs and is interrupted by the user (Esc), then ends.
	const ctrl = new AbortController();
	const unregB = registerPyToolBridge("S", "B", {
		toolSession: stubSession("B"),
		signal: ctrl.signal,
		emitStatus: e => statusB.push(e),
		abortRequested: () => ctrl.signal.aborted,
	});
	ctrl.abort();
	unregB();

	// Cell A's thread reads artifact://1 (prelude sends run "").
	const bg = await post(info, { session: "S", run: "", name: "__artifacts_ready__", args: { id: "1", root: dir } });
	console.log("background read (run=''):", JSON.stringify(bg));

	// A call carrying the ended run A, for an ordinary tool.
	const stale = await post(info, { session: "S", run: "A", name: "read", args: { path: "/etc/hostname" } });
	console.log("stale run A, tool=read:", JSON.stringify(stale));
	console.log("status events delivered to cell B:", statusB.length, " to cell A:", statusA.length);
	expect(bg.ok).toBe(true);
});

it("stale run id is served by the newest cell's entry", async () => {
	const info = await ensurePyToolBridge();
	const seen: string[] = [];
	const unregA = registerPyToolBridge("T", "A", {
		toolSession: stubSession("A"),
		emitStatus: () => seen.push("A"),
	});
	unregA();
	const unregB = registerPyToolBridge("T", "B", {
		toolSession: stubSession("B"),
		emitStatus: () => seen.push("B"),
	});
	const stale = await post(info, { session: "T", run: "A", name: "__artifacts_ready__", args: { id: "1", root: dir } });
	console.log("stale run A while B live:", JSON.stringify(stale), "emitStatus owners:", seen);
	unregB();
	expect(stale.ok).toBe(false);
});


it("stale run id runs an ordinary tool under the newest cell", async () => {
	const info = await ensurePyToolBridge();
	const unregA = registerPyToolBridge("U", "A", { toolSession: stubSession("A") });
	unregA();
	const live = await post(info, { session: "U", run: "A", name: "read", args: { path: "/etc/hostname" } });
	console.log("stale run A, tool=read, no newer cell:", JSON.stringify(live));
	let used = "";
	const unregB = registerPyToolBridge("U", "B", {
		toolSession: new Proxy({}, { get: (_t, p) => { used ||= `B.${String(p)}`; return undefined; } }) as never,
	});
	const r = await post(info, { session: "U", run: "A", name: "read", args: { path: "/etc/hostname" } });
	console.log("stale run A, tool=read, cell B live:", JSON.stringify(r).slice(0, 200), "| first field read on B's session:", used);
	unregB();
	expect(used).toBe("");
});