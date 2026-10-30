import { expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const borrowed: string[] = [];
const called: string[] = [];
const real = { ...(await import("@oh-my-pi/pi-coding-agent/eval/py/executor")) };
mock.module("@oh-my-pi/pi-coding-agent/eval/py/executor", () => ({
	...real,
	borrowPythonKernelSession: (o: { cwd: string }) => {
		borrowed.push(o.cwd);
		return () => {};
	},
	callPythonTool: async (_n: string, _a: unknown, o: { cwd: string }) => {
		called.push(o.cwd);
		return { ok: true, value: "x" };
	},
	describePythonTools: async () => ({ tools: [], missing: [] }),
}));

it("fs.rm on a symlink (old clear path) removes only the link", async () => {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "rmlink-"));
	await fs.mkdir(path.join(d, "target"));
	await fs.symlink(path.join(d, "target"), path.join(d, "link"));
	await fs.rm(path.join(d, "link"), { recursive: true, force: true });
	console.error("old path: target survives fs.rm(link):", await fs.stat(path.join(d, "target")).then(() => true, () => false));
	await fs.rm(d, { recursive: true, force: true });
});

it("borrowEvalToolKernels holds the cwd at borrow time; tool calls follow session.cwd", async () => {
	const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
	const { borrowEvalToolKernels, createEvalCustomTools } = await import("@oh-my-pi/pi-coding-agent/task/eval-tools");
	const session: any = {
		cwd: "/work/a",
		settings: Settings.isolated(),
		getEvalSessionId: () => "s1",
		getEvalKernelOwnerId: () => "owner",
	};
	session.get = (k: string) => session.settings.get(k);
	const descriptors: any = [{ name: "t", language: "python", description: "d", parameters: { type: "object" } }];
	const tools = createEvalCustomTools(session, descriptors);
	const release = borrowEvalToolKernels(session, descriptors);
	session.cwd = "/work/b"; // parent's next cell runs elsewhere — the case the borrow exists for
	await tools[0].execute("id", {}, undefined, undefined as any, undefined);
	release();
	console.error("borrowed kernel cwd:", borrowed, " tool call kernel cwd:", called);
});
