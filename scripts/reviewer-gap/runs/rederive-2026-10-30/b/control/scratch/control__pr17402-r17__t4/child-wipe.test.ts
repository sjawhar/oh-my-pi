import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, getCustomApi } from "@oh-my-pi/pi-ai";
import { getOAuthProviderEntry } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/test/helpers/agent-session-setup";

const providerName = "probe-provider";
const modelId = "probe-model";
const apiId = "probe-api";

let tempDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;

beforeEach(() => {
	tempDir = path.join(os.tmpdir(), `probe-${Snowflake.next()}`);
	fs.mkdirSync(path.join(tempDir, "agent"), { recursive: true });
	setAgentDir(path.join(tempDir, "agent"));
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	settings = Settings.isolated();
	settings.setModelRole("default", `${providerName}/${modelId}`);
});
afterEach(() => {
	authStorage.close();
	removeSyncWithRetries(tempDir);
});

const shared: ExtensionFactory = pi => {
	pi.registerProvider(providerName, {
		baseUrl: "https://x.example/v1",
		apiKey: "KEY",
		api: apiId,
		streamSimple: () => createAssistantMessageEventStream(),
		usage: { id: providerName, async fetchUsage() { return { provider: providerName, fetchedAt: 1, limits: [] }; } },
		oauth: {
			name: "probe",
			login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
		},
		models: [
			{ id: modelId, name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
		],
	});
};

function opts() {
	return {
		cwd: tempDir, agentDir: tempDir, authStorage, modelRegistry, settings,
		sessionManager: SessionManager.inMemory(), disableExtensionDiscovery: true,
		skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], enableMCP: false,
		enableLsp: false, skipPythonPreflight: true, rules: [], preloadedCustomToolPaths: [], toolNames: ["read"],
	};
}

for (const restrictToolNames of [true, false]) {
	test(`parent's provider after ${restrictToolNames ? "restricted" : "UNRESTRICTED"} child disposes`, async () => {
		const { session: parent } = await createAgentSession({ ...opts(), extensions: [shared] });
		try {
			console.log("before child: api", !!getCustomApi(apiId), "usage", !!authStorage.usage.providerFor(providerName), "oauth", !!getOAuthProviderEntry(providerName));
			const { session: child } = await createAgentSession({
				...opts(), model: parent.model, restrictToolNames, preloadedPreparedExtensions: parent.preparedExtensions,
			});
			console.log("child live:  api", !!getCustomApi(apiId), "usage", !!authStorage.usage.providerFor(providerName), "oauth", !!getOAuthProviderEntry(providerName));
			await child.dispose();
			const after = { api: !!getCustomApi(apiId), usage: !!authStorage.usage.providerFor(providerName), oauth: !!getOAuthProviderEntry(providerName) };
			console.log("child gone:  ", JSON.stringify(after), "parent disposed?", parent.isDisposed);
			expect(after).toEqual({ api: true, usage: true, oauth: true });
		} finally {
			await parent.dispose();
		}
	}, 30000);
}
