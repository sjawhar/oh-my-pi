import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class FailingRewriteStorage extends MemorySessionStorage {
	failNextRewrite = false;

	override async writeTextAtomic(
		path: string,
		content: string,
		options?: Parameters<MemorySessionStorage["writeTextAtomic"]>[2],
	): Promise<void> {
		if (this.failNextRewrite) {
			this.failNextRewrite = false;
			throw new Error("ENOSPC: synthetic session rewrite failure");
		}
		await super.writeTextAtomic(path, content, options);
	}
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
});
