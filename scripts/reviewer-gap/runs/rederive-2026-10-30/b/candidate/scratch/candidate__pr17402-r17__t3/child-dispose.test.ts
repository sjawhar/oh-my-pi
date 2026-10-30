import { afterEach, expect, test } from "bun:test";
import { clearCustomApis, getCustomApi } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/api-registry.ts";
import { getOAuthProviderEntry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/registry/oauth/index.ts";
import { ModelRegistry, type ProviderConfigInput } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/model-registry.ts";
import { ExtensionRuntime } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/loader.ts";
import { AuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/auth-storage.ts";

afterEach(() => clearCustomApis());

const SRC = "/ext/provider.ts";
const makeConfig = (): ProviderConfigInput => ({
	baseUrl: "https://x.example.com/v1",
	apiKey: "X_KEY",
	api: "probe-custom-api",
	streamSimple: () => ({}) as never,
	models: [
		{
			id: "m",
			name: "M",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
	],
	oauth: { name: "X", login: async () => "k", refreshToken: async c => c, getApiKey: c => c.access } as never,
	usage: { id: "probe-provider", fetchUsage: async () => null } as never,
});

// Mirrors sdk.ts createAgentSessionScoped lines 2909-2917 for a session that loads SRC.
function sessionStart(registry: ModelRegistry, runtime: ExtensionRuntime) {
	registry.syncExtensionSources([SRC]);
	registry.clearSourceRegistrations(new Set([SRC]));
	registry.registerProvider("probe-provider", makeConfig(), SRC, runtime);
}

test("parent's provider after a subagent that rebound the same extension is disposed", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	parent.beginSession();
	sessionStart(registry, parent);
	console.log("parent only: customApi", !!getCustomApi("probe-custom-api"), "oauth", !!getOAuthProviderEntry("probe-provider"), "usage", !!authStorage.usage.providerFor("probe-provider" as never), "model", !!registry.find("probe-provider", "m"));

	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();
	sessionStart(registry, child);
	releaseChild(); // child AgentSession.dispose()
	console.log("parent.isRetired", parent.isRetired, "child.isRetired", child.isRetired);
	console.log("after child dispose: customApi", !!getCustomApi("probe-custom-api"), "oauth", !!getOAuthProviderEntry("probe-provider"), "usage", !!authStorage.usage.providerFor("probe-provider" as never), "model", !!registry.find("probe-provider", "m"));
	authStorage.close();
});
