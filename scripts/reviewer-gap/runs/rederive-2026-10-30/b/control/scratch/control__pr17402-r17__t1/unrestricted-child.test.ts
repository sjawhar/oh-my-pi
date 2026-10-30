import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, getCustomApi } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/index.ts";
import { getOAuthProviderEntry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/registry/oauth/index.ts";
import { ModelRegistry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/model-registry.ts";
import { Settings } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/settings.ts";
import { type CreateAgentSessionOptions, createAgentSession, type ExtensionFactory } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/sdk.ts";
import type { AuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/auth-storage.ts";
import { SessionManager } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/session-manager.ts";
import { removeSyncWithRetries, setAgentDir, Snowflake } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/utils/src/index.ts";
import { createInMemoryAuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/test/helpers/agent-session-setup.ts";

const providerName = "probe-provider";
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
	settings.setModelRole("default", `${providerName}/m`);
});
afterEach(() => {
	modelRegistry.clearSourceRegistrations("<inline-0>");
	authStorage.close();
	removeSyncWithRetries(tempDir);
});

const ext: ExtensionFactory = pi => {
	pi.registerProvider(providerName, {
		baseUrl: "https://x.example/v1",
		apiKey: "K",
		api: apiId,
		streamSimple: () => createAssistantMessageEventStream(),
		usage: { id: providerName, async fetchUsage() { return { provider: providerName, fetchedAt: 1, limits: [] }; } },
		oauth: { name: "P", login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 1e6 }) },
		models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
	});
};

function opts(): CreateAgentSessionOptions {
	return {
		cwd: tempDir, agentDir: tempDir, authStorage, modelRegistry, settings,
		sessionManager: SessionManager.inMemory(), disableExtensionDiscovery: true, skills: [], contextFiles: [],
		promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false, skipPythonPreflight: true,
		rules: [], preloadedCustomToolPaths: [], toolNames: ["read"],
	};
}

for (const restrictToolNames of [true, false]) {
	test(`parent registrations after child dispose (restrictToolNames=${restrictToolNames})`, async () => {
		const { session: parent } = await createAgentSession({ ...opts(), extensions: [ext] });
		console.log("before child:", !!getCustomApi(apiId), !!getOAuthProviderEntry(providerName), !!authStorage.usage.providerFor(providerName));
		const { session: child } = await createAgentSession({
			...opts(), model: parent.model, restrictToolNames, preloadedPreparedExtensions: parent.preparedExtensions,
		});
		console.log("child live:", !!getCustomApi(apiId), !!getOAuthProviderEntry(providerName), !!authStorage.usage.providerFor(providerName));
		await child.dispose();
		const after = [!!getCustomApi(apiId), !!getOAuthProviderEntry(providerName), !!authStorage.usage.providerFor(providerName)];
		console.log(`after child dispose (restrict=${restrictToolNames}): customApi=${after[0]} oauth=${after[1]} usage=${after[2]} parentDisposed=${parent.isDisposed}`);
		await parent.dispose();
		expect(after).toEqual([true, true, true]);
	});
}
