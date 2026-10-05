import { afterEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
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
});
