import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

// An extension that starts a turn from `session_start` (pi.sendMessage with
// triggerTurn) must not decide when the host can take its first command.
describe("turn started by a session_start handler", () => {
	afterEach(() => vi.restoreAllMocks());

	it("lets an RPC client negotiate, read state and abort while the startup turn runs", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-startup-turn-"));
		const client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "startup-turn-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		try {
			// start() waits for `ready` and then for the `negotiate_protocol` response. The
			// fixture's startup turn streams for 60s, so both commands are answered only if
			// the host reads input while that turn runs.
			await withTimeout(client.start(), 10_000, "negotiate_protocol was not answered during the startup turn");
			const state = await withTimeout(client.getState(), 10_000, "get_state was not answered");
			expect(state.isStreaming).toBe(true);

			const ended = Promise.withResolvers<void>();
			const unsubscribe = client.onEvent(event => {
				if (event.type === "agent_end") ended.resolve();
			});
			try {
				await client.abort();
				await withTimeout(ended.promise, 10_000, "abort did not end the startup turn");
			} finally {
				unsubscribe();
			}
			expect((await client.getState()).isStreaming).toBe(false);
		} finally {
			await client.stop();
			await removeWithRetries(directory);
		}
	}, 30_000);

	it("runs to completion before print mode sends its first prompt", async () => {
		const dir = TempDir.createSync("@pi-print-startup-turn-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback === "function") callback();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		// The startup turn's model call is still streaming when initialization would
		// otherwise hand control back; the initial prompt must not race it.
		const model = createMockModel({
			responses: [{ content: ["startup turn"], delayMs: 200 }, { content: ["PONG"] }],
		});
		auth.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		const sessionManager = SessionManager.inMemory(dir.path());
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", () => {
					pi.sendMessage(
						{ customType: "startup-announce", content: "extension started", display: true },
						{ triggerTurn: true },
					);
				});
			},
			dir.path(),
			new EventBus(),
			runtime,
			"startup-turn",
		);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: model.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, dir.path(), sessionManager, modelRegistry),
		});
		try {
			const code = await runPrintMode(session, { mode: "text", initialMessage: "Reply with PONG" });
			// If the initial prompt raced the startup turn, AgentBusyError would reject runPrintMode here.
			expect(code).toBe(0);
			expect(model.calls).toHaveLength(2);
		} finally {
			await session.dispose();
			auth.close();
			await dir.remove();
		}
	});
});
