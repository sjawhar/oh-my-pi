import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

class FailingRewriteStorage extends MemorySessionStorage {
	failNextRewrite = false;

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failNextRewrite) {
			this.failNextRewrite = false;
			throw new Error("ENOSPC: synthetic session rewrite failure");
		}
		await super.writeTextAtomic(path, content, options);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

function clearCommandRuntime(session: AgentSession): { ctx: InteractiveModeContext } {
	const ctx = {
		session,
		sessionManager: session.sessionManager,
		editor: { setText: () => {} },
		statusLine: { invalidate: () => {} },
		clearTransientSessionUi: () => {},
		resetTranscript: () => {},
		updateEditorBorderColor: () => {},
		present: () => {},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	ctx.handleResetContextCommand = () => controller.handleResetContextCommand();
	return { ctx };
}

describe("AgentSession persistence failure context", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		session = undefined;
	});

	it("delivers one hidden next-turn warning after a session persistence failure", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await sessionManager.appendEntriesAtomically(() => sessionManager.appendCustomEntry("durable-before-rewrite"));
		storage.failNextRewrite = true;
		await expect(
			sessionManager.appendEntriesAtomically(() => sessionManager.appendCustomEntry("rejected-rewrite")),
		).rejects.toThrow("synthetic session rewrite failure");

		await session.prompt("continue the task");

		const warning = session.agent.state.messages.find(
			message => message.role === "custom" && message.customType === "session-persistence-error",
		);
		expect(warning).toMatchObject({ display: false, attribution: "agent" });
		if (warning?.role !== "custom" || typeof warning.content !== "string") {
			throw new Error("Expected the persistence warning to be a hidden custom message");
		}
		const providerContext = JSON.stringify(mock.calls[0]?.context.messages);
		expect(providerContext.split(warning.content).length - 1).toBe(1);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "session-persistence-error",
			),
		).toHaveLength(1);
	});

	it("delivers the persistence warning after a real /clear while the failure remains latched", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const durableEntryId = sessionManager.appendCustomEntry("durable-before-rewrite");
		const durableEntry = sessionManager.getEntry(durableEntryId);
		if (!durableEntry || durableEntry.type !== "custom") throw new Error("Expected durable custom entry");
		durableEntry.data = { rewritten: true };
		storage.failNextRewrite = true;
		await expect(sessionManager.rewriteEntries()).rejects.toThrow("synthetic session rewrite failure");
		expect(sessionManager.hasPersistenceFailure()).toBe(true);

		expect(await executeBuiltinSlashCommand("/clear", clearCommandRuntime(session))).toBe(true);
		await session.prompt("continue the task");

		const warning = session.agent.state.messages.find(
			message => message.role === "custom" && message.customType === "session-persistence-error",
		);
		expect(warning).toMatchObject({ display: false, attribution: "agent" });
		if (warning?.role !== "custom" || typeof warning.content !== "string") {
			throw new Error("Expected the persistence warning to be a hidden custom message");
		}
		const providerContext = JSON.stringify(mock.calls[0]?.context.messages);
		expect(providerContext.split(warning.content).length - 1).toBe(1);
		await sessionManager.recoverPersistenceFromCurrentState();
	});
});
