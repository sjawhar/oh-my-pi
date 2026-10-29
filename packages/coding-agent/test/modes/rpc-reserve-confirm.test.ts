/**
 * Contract: the coding-plan reserve prompt reaches an RPC host only when that
 * host has declared a dialog surface — `--mode rpc-ui`, or a `set_ask_dialog`
 * opt-in. `docs/settings.md` promises that a session with nobody to ask (and
 * it names "RPC without a UI") keeps its model without waiting; a scripted
 * client that never answers `extension_ui_request` is exactly that session, so
 * it must not be held for `retry.usageReserveConfirmTimeout` first.
 *
 * The fixture sets that timeout to an hour: a turn that settles inside the
 * test proves nobody waited on an answer, and a held turn fails by deadline.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readJsonl, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "reserve-confirm-rpc-agent.ts");

interface ReserveRun {
	/** Every `confirm` dialog the host was sent. */
	confirms: Record<string, unknown>[];
	notices: string[];
	/** The model id the session still runs after the turn. */
	model: string | undefined;
}

interface ReserveOptions {
	/** `--mode rpc-ui`: the host routes tool dialogs. */
	ui: boolean;
	/** Send `set_ask_dialog` before prompting. */
	optIn?: boolean;
	/** Answer a `confirm` dialog with this; omitted means the client ignores it. */
	answer?: boolean;
}

async function runReserveSession(options: ReserveOptions): Promise<ReserveRun> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-reserve-"));
	const child = Bun.spawn([process.execPath, FIXTURE], {
		cwd: directory,
		env: {
			PATH: Bun.env.PATH,
			HOME: directory,
			PI_CODING_AGENT_DIR: directory,
			PI_NO_TITLE: "1",
			CI: "true",
			RESERVE_RPC_UI: options.ui ? "1" : "0",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).body;
	if (!stdout) throw new Error("Reserve RPC fixture did not expose stdout");
	const stderr = new Response(child.stderr).text();
	const send = async (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};

	const run: ReserveRun = { confirms: [], notices: [], model: undefined };
	let finished = false;
	try {
		await withTimeout(
			(async () => {
				for await (const frame of readJsonl<unknown>(stdout)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						if (options.optIn) await send({ id: "opt-in", type: "set_ask_dialog", enabled: true });
						else await send({ id: "turn", type: "prompt", message: "keep working" });
					} else if (frame.type === "response" && frame.id === "opt-in") {
						await send({ id: "turn", type: "prompt", message: "keep working" });
					} else if (frame.type === "notice" && typeof frame.message === "string") {
						run.notices.push(frame.message);
					} else if (frame.type === "extension_ui_request" && frame.method === "confirm") {
						run.confirms.push(frame);
						// No response at all is the scripted client this guards.
						if (options.answer !== undefined) {
							await send({ type: "extension_ui_response", id: frame.id, confirmed: options.answer });
						}
					} else if (frame.type === "prompt_result" && frame.id === "turn") {
						await send({ id: "state", type: "get_state" });
					} else if (frame.type === "response" && frame.id === "state") {
						const data = frame.data;
						const model = isRecord(data) ? data.model : undefined;
						run.model = isRecord(model) && typeof model.id === "string" ? model.id : undefined;
						finished = true;
						break;
					}
				}
			})(),
			60_000,
			"Reserve RPC session did not settle its turn",
		);
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
		await removeWithRetries(directory);
	}
	if (!finished) throw new Error(`Reserve RPC fixture ended early: ${await stderr}`);
	await stderr;
	return run;
}

describe("RPC coding-plan reserve prompt", () => {
	it("never asks a plain RPC host and keeps its model", async () => {
		const run = await runReserveSession({ ui: false });

		expect(run.confirms).toEqual([]);
		expect(run.model).toBe("claude-sonnet-4-5");
		expect(run.notices.some(message => message.includes("nobody to ask"))).toBe(true);
	}, 90_000);

	it("asks an rpc-ui host and honours its answer", async () => {
		const run = await runReserveSession({ ui: true, answer: true });

		expect(run.confirms).toHaveLength(1);
		expect(run.confirms[0]).toMatchObject({ method: "confirm", title: "Coding-plan reserve reached" });
		expect(run.model).toBe("gpt-4o-mini");
		expect(run.notices.some(message => message.includes("nobody to ask"))).toBe(false);
	}, 90_000);

	it("starts asking a plain RPC host that opts in with set_ask_dialog", async () => {
		const run = await runReserveSession({ ui: false, optIn: true, answer: false });

		expect(run.confirms).toHaveLength(1);
		expect(run.model).toBe("claude-sonnet-4-5");
		expect(run.notices.some(message => message.includes("nobody to ask"))).toBe(false);
	}, 90_000);
});
