import { afterEach, expect, test } from "bun:test";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/index.ts";
import { getOAuthProviderEntry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/registry/oauth/index.ts";
import { ModelRegistry, type ProviderConfigInput } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/model-registry.ts";
import { ExtensionRuntime } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/loader.ts";
import { AuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/auth-storage.ts";

afterEach(() => clearCustomApis());

test("child session creation + disposal strands the parent's provider", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const src = "ext://shared";
	const mk = (): ProviderConfigInput => ({
		baseUrl: "https://x.example.com/v1",
		apiKey: "KEY",
		api: "probe-custom-api",
		streamSimple: () => ({}) as unknown as AssistantMessageEventStream,
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
		oauth: { name: "P", login: async () => ({ access: "a", refresh: "r", expires: 0 }) },
		usage: { id: "probe", fetchUsage: async () => null } as never,
	});

	// Parent session: loads extension, registers, claims its runtime.
	const parent = new ExtensionRuntime();
	const releaseParent = parent.beginSession();
	registry.syncExtensionSources([src]);
	registry.clearSourceRegistrations(new Set([src]));
	registry.registerProvider("probe-prov", mk(), src, parent);
	console.log("parent only:", {
		api: !!getCustomApi("probe-custom-api"),
		oauth: !!getOAuthProviderEntry("probe-prov"),
		usage: !!authStorage.usage.providerFor("probe-prov"),
		model: !!registry.find("probe-prov", "m"),
	});

	// Child (subagent) session: sdk.ts createAgentSessionScoped does exactly this on the shared registry.
	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();
	registry.syncExtensionSources([src]);
	registry.clearSourceRegistrations(new Set([src]));
	registry.registerProvider("probe-prov", mk(), src, child);

	// Child disposes.
	releaseChild();
	const after = {
		parentRetired: parent.isRetired,
		api: !!getCustomApi("probe-custom-api"),
		oauth: !!getOAuthProviderEntry("probe-prov"),
		usage: !!authStorage.usage.providerFor("probe-prov"),
		model: !!registry.find("probe-prov", "m"),
	};
	console.log("after child disposal:", after);
	releaseParent();
	authStorage.close();
	expect(after.api).toBe(true);
	expect(after.oauth).toBe(true);
});
