import { afterEach, describe, expect, it } from "bun:test";
import { type AgentTool, Agent } from "@oh-my-pi/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

interface Harness {
	api: ExtensionAPI;
	mock: MockModel;
	session: AgentSession;
}

interface HarnessOptions {
	handler?: (context: Context, options?: SimpleStreamOptions) => MockResponse | Promise<MockResponse>;
	model?: "active" | "none";
	tools?: AgentTool[];
}

function assertNoPrimaryDelivery(session: AgentSession): void {
	expect(session.queuedMessageCount).toBe(0);
	expect(session.agent.hasQueuedMessages()).toBe(false);
	expect(session.agent.peekSteeringQueue()).toEqual([]);
}

describe("ExtensionAPI.askEphemeral", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
		const mock = createMockModel({
			handler: options.handler ?? (() => ({ content: ["side answer"] })),
		});
		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		let api: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				api = pi;
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"ask-ephemeral-test-extension",
		);
		const modelRegistry = {
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		};
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry as never);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: options.model === "none" ? undefined : mock.model,
				systemPrompt: ["Test"],
				messages: [],
				tools: options.tools ?? [],
			},
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: modelRegistry as never,
			extensionRunner: runner,
			sideStreamFn: mock.stream,
		});
		sessions.push(session);
		await initializeExtensions(session, {
			mode: "rpc",
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		if (!api) throw new Error("Expected extension API");
		return { api, mock, session };
	}

	it("answers alongside a streaming primary turn without changing that turn's history or queues", async () => {
		const primaryStarted = Promise.withResolvers<void>();
		const releasePrimary = Promise.withResolvers<void>();
		let toolExecutions = 0;
		const tool: AgentTool = {
			name: "primary_tool",
			label: "Primary tool",
			description: "Must not run in a side turn.",
			parameters: type({}),
			execute: async () => {
				toolExecutions += 1;
				return { content: [], details: {} };
			},
		};
		const { api, mock, session } = await createHarness({
			tools: [tool],
			handler: async (_context, options) => {
				if (options?.sessionId?.startsWith(`${session.sessionId}:side:`)) {
					return {
						content: ["Dispatch answer", { type: "toolCall", name: "primary_tool", arguments: {} }],
					};
				}
				primaryStarted.resolve();
				await releasePrimary.promise;
				return { content: ["Primary answer"] };
			},
		});

		const primaryMessageStarted = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "user") primaryMessageStarted.resolve();
		});
		const primary = session.prompt("Continue the primary task");
		await primaryStarted.promise;
		await primaryMessageStarted.promise;
		expect(session.isStreaming).toBe(true);
		const historyBefore = structuredClone(session.messages);

		try {
			const result = await api.askEphemeral({ prompt: "What is the current status?" });

			expect(result).toEqual({ replyText: "Dispatch answer" });
			expect(mock.calls).toHaveLength(2);
			const sideCall = mock.calls[1];
			expect(sideCall?.options?.sessionId).toStartWith(`${session.sessionId}:side:`);
			const sideMessage = sideCall?.context.messages.at(-1);
			if (sideMessage?.role !== "user" || !Array.isArray(sideMessage.content)) {
				throw new Error("Expected a rendered ephemeral user prompt");
			}
			const sidePrompt = sideMessage.content.find(
				(content): content is { type: "text"; text: string } => content.type === "text",
			);
			if (!sidePrompt) throw new Error("Expected text in ephemeral user prompt");
			expect(sidePrompt.text).toContain("<btw>");
			expect(sidePrompt.text).toContain("NEVER use tools.");
			expect(sidePrompt.text).toContain("What is the current status?");
			expect(session.messages).toEqual(historyBefore);
			expect(toolExecutions).toBe(0);
			assertNoPrimaryDelivery(session);
		} finally {
			unsubscribe();
			releasePrimary.resolve();
		}
		await primary;
	});

	it("rejects unavailable ephemeral calls without queuing a primary delivery", async () => {
		const noModel = await createHarness({ model: "none" });
		await expect(noModel.api.askEphemeral({ prompt: "status?" })).rejects.toThrow("No active model on session");
		assertNoPrimaryDelivery(noModel.session);

		const aborted = await createHarness({
			handler: () => ({ content: ["unreachable"], delayMs: 60_000 }),
		});
		const abortController = new AbortController();
		abortController.abort();
		await expect(aborted.api.askEphemeral({ prompt: "status?", signal: abortController.signal })).rejects.toThrow(
			"Mock aborted during delay.",
		);
		assertNoPrimaryDelivery(aborted.session);

		const providerFailure = await createHarness({
			handler: () => ({ throw: "provider unavailable" }),
		});
		await expect(providerFailure.api.askEphemeral({ prompt: "status?" })).rejects.toThrow("provider unavailable");
		assertNoPrimaryDelivery(providerFailure.session);

		const disposed = await createHarness();
		disposed.session.beginDispose();
		await expect(disposed.api.askEphemeral({ prompt: "status?" })).rejects.toThrow("Session disposed");
		assertNoPrimaryDelivery(disposed.session);
	});
});
