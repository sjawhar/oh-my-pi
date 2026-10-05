import { afterEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("refused input on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	// Regression: the session's converter must apply the replay policy before
	// conversion erases the refused-turn marker; otherwise every later request
	// resends the refused prompt and draws the same refusal.
	it("leaves a refused prompt out of the next request a real session sends", async () => {
		using tempDir = TempDir.createSync("@pi-refused-turn-wire-");
		const api = "test-refused-turn-wire";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (contexts.length === 1) {
					const refusal: AssistantMessage = {
						...createAssistantMessage(""),
						content: [],
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
						errorMessage: "Refusal (cyber): Classifier declined this turn.",
					};
					stream.push({ type: "error", reason: "error", error: refusal });
					return;
				}
				const message = createAssistantMessage("OK");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "OK", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "refused-turn-wire",
			name: "Refused turn wire",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		try {
			await session.prompt("PAYLOAD the classifier refuses");
			await session.waitForIdle();
			await session.prompt("Reply with the single word OK.");
			await session.waitForIdle();

			expect(contexts).toHaveLength(2);
			const sent = JSON.stringify(contexts[1]!.messages);
			expect(sent).not.toContain("PAYLOAD");
			expect(sent).toContain("Reply with the single word OK.");
		} finally {
			authStorage.close();
		}
	});

	// Regression: a steer queued during a refused tool-call turn counted as new
	// input while the fallback retry was still answering the refused step, so the
	// fallback model never received the refused prompt.
	it("keeps refused input for the fallback retry, then leaves it out once recovery gives up, live and after a reload", async () => {
		using tempDir = TempDir.createSync("@pi-refused-turn-fallback-");
		const api = "test-refused-turn-fallback";
		const requests: Array<{ model: string; messages: string }> = [];
		let liveSession: AgentSession | undefined;
		const refusal = (content: AssistantMessage["content"]): AssistantMessage => ({
			...createAssistantMessage(""),
			content,
			stopReason: "error",
			stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
			errorMessage: "Refusal (cyber): Classifier declined this turn.",
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const modelSpec = {
			api,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 4096,
		};
		modelRegistry.registerProvider("refusal-wire", {
			api,
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:8080/v1",
			models: [
				{ id: "primary", name: "Primary", ...modelSpec },
				{ id: "fallback", name: "Fallback", ...modelSpec },
			],
			streamSimple: (model, context) => {
				requests.push({ model: model.id, messages: JSON.stringify(context.messages) });
				const stream = new AssistantMessageEventStream();
				const primaryCalls = requests.filter(request => request.model === "primary").length;
				const fallbackCalls = requests.filter(request => request.model === "fallback").length;
				queueMicrotask(() => {
					if (model.id === "primary" && primaryCalls === 1) {
						void liveSession?.prompt("STEER also check b.txt", { streamingBehavior: "steer" });
						const call = {
							type: "toolCall" as const,
							id: "call_refused",
							name: "read",
							arguments: { path: "a.txt" },
						};
						const refused = refusal([call]);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: refused });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: refused });
						stream.push({ type: "error", reason: "error", error: refused });
						return;
					}
					if (model.id === "fallback" && fallbackCalls === 1) {
						stream.push({ type: "error", reason: "error", error: refusal([{ type: "text", text: "No." }]) });
						return;
					}
					const message = createAssistantMessage("OK");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "OK", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const primary = modelRegistry.find("refusal-wire", "primary");
		if (!primary) throw new Error("Expected the primary test model to register");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { default: ["refusal-wire/fallback"] },
		});
		settings.setModelRole("default", "refusal-wire/primary");
		const sessionDir = tempDir.join("sessions");
		const start = async (sessionManager: SessionManager) => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings,
				model: primary,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			sessions.push(session);
			return session;
		};

		try {
			const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
			const session = await start(sessionManager);
			liveSession = session;
			await session.prompt("PAYLOAD the classifier refuses");
			await session.waitForIdle();

			const fallbackRetry = requests.find(request => request.model === "fallback");
			expect(fallbackRetry?.messages).toContain("PAYLOAD");
			expect(fallbackRetry?.messages).toContain("STEER also check b.txt");

			await session.prompt("Reply with the single word OK.");
			await session.waitForIdle();
			const afterGiveUp = requests.at(-1)!.messages;
			expect(afterGiveUp).not.toContain("PAYLOAD");
			expect(afterGiveUp).toContain("Reply with the single word OK.");

			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected the session to persist a file");
			const reloaded = await start(
				await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true }),
			);
			await session.prompt("Continue.");
			await session.waitForIdle();
			const live = requests.at(-1)!.messages;
			await reloaded.prompt("Continue.");
			await reloaded.waitForIdle();
			const strip = (wire: string) =>
				(JSON.parse(wire) as Array<{ role: string; content: unknown }>).map(message => ({
					role: message.role,
					content: message.content,
				}));
			expect(live).not.toContain("PAYLOAD");
			expect(strip(requests.at(-1)!.messages)).toEqual(strip(live));
		} finally {
			authStorage.close();
		}
	});
});
