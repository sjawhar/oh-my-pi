import { afterEach, expect, test } from "bun:test";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/api-registry";
import { getOAuthProviderEntry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/registry/oauth/index";
import { ModelRegistry, type ProviderConfigInput } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/model-registry";
import { ExtensionRuntime } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/loader";
import { AuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/auth-storage";

const model = (id: string): NonNullable<ProviderConfigInput["models"]>[number] => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

afterEach(() => clearCustomApis());

function cfg(who: string, calls: string[]): ProviderConfigInput {
	return {
		baseUrl: `https://${who}.example.com/v1`,
		apiKey: `${who.toUpperCase()}_KEY`,
		api: "probe-sibling-api",
		streamSimple: () => {
			calls.push(who);
			return {} as unknown as AssistantMessageEventStream;
		},
		models: [model(`${who}-model`)],
		oauth: { name: who, login: async () => `${who}-token` },
		usage: { id: "p", fetchUsage: async () => ({ provider: "p", fetchedAt: 1, limits: [] }) } as never,
	};
}

test("child withdrawal vs parent registration", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	const child = new ExtensionRuntime();
	parent.beginSession();
	const releaseChild = child.beginSession();
	const calls: string[] = [];
	registry.registerProvider("p", cfg("parent", calls), "ext://same", parent);
	console.log("after parent register: find parent-model =", !!registry.find("p", "parent-model"));
	registry.registerProvider("p", cfg("child", calls), "ext://same", child);
	console.log("after child register: find parent-model =", !!registry.find("p", "parent-model"), "child-model =", !!registry.find("p", "child-model"));

	releaseChild();
	console.log("after child RETIRED (no unregister):");
	console.log("  find parent-model =", !!registry.find("p", "parent-model"), " child-model =", !!registry.find("p", "child-model"));
	console.log("  keys.source(p) =", authStorage.keys.source("p"));
	getCustomApi("probe-sibling-api")?.streamSimple({} as never, {} as never, {} as never);
	console.log("  stream answered by =", calls.at(-1));
	console.log("  oauth entry label =", getOAuthProviderEntry("p")?.provider.name);

	// Child's unregister on a still-live child (begin again)
	const releaseChild2 = child.beginSession();
	registry.unregisterProvider("p", child);
	console.log("after child unregisterProvider(p, child):");
	console.log("  find parent-model =", !!registry.find("p", "parent-model"), " child-model =", !!registry.find("p", "child-model"));
	console.log("  keys.source(p) =", authStorage.keys.source("p"));
	console.log("  oauth entry label =", getOAuthProviderEntry("p")?.provider.name);
	console.log("  usage providerFor(p) defined =", !!authStorage.usage.providerFor("p" as never));
	console.log("  custom api defined =", !!getCustomApi("probe-sibling-api"));
	releaseChild2();
	authStorage.close();
	expect(true).toBe(true);
});
