/**
 * An RPC session whose primary model sits inside its coding-plan reserve, so
 * the first turn reaches `retry.usageReservePolicy = "confirm"`.
 *
 * `RESERVE_RPC_UI=1` is `--mode rpc-ui`: the host declared that it routes tool
 * dialogs, which is what `runRpcMode` sees as `setToolUIContext`. Without it
 * the fixture is a plain `--mode rpc` host, the scripted-client case that
 * answers no `extension_ui_request`.
 */
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
if (!primaryModel || !fallbackModel) throw new Error("Expected bundled reserve-confirmation models");

const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
authStorage.keys.setRuntime("openai", "test-key");
// The primary's plan is inside its reserve on every preflight; the fallback is healthy.
authStorage.health.model = async (provider: string): Promise<ModelUsageHealth> =>
	provider === primaryModel.provider
		? {
				state: "reserve",
				accounts: [
					{ credentialId: 1, credentialType: "oauth", selected: true, state: "reserve", remainingFraction: 0.08 },
				],
			}
		: { state: "healthy", accounts: [] };

const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const mock = createMockModel({ handler: { content: ["turn finished"] } });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const settings = Settings.isolated({
	"compaction.enabled": false,
	"retry.usageAwareFallback": true,
	"retry.usageReservePct": 10,
	"retry.usageReservePolicy": "confirm",
	// An hour: any turn held on the prompt outlives the test, so a turn that
	// settles at all proves the host was never asked.
	"retry.usageReserveConfirmTimeout": 3600,
	"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
});
settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings,
	modelRegistry,
});
await runRpcMode(session, {
	setToolUIContext: Bun.env.RESERVE_RPC_UI === "1" ? () => {} : undefined,
});
