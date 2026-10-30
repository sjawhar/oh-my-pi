import { afterEach, expect, test } from "bun:test";
import { clearCustomApis, getCustomApi } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/index.ts";
import { getOAuthProviderEntry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/registry/oauth/index.ts";
import { ModelRegistry, type ProviderConfigInput } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/model-registry.ts";
import type { ExtensionCallbackOwner } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/types.ts";
import { AuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/auth-storage.ts";
import { TempDir } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/utils/src/index.ts";

function owner(name: string): ExtensionCallbackOwner & { retire(): void; name: string } {
	let retired = false;
	return {
		name,
		retire() {
			retired = true;
		},
		get isRetired() {
			return retired;
		},
		ownCallback: fn => (...args) => (retired ? undefined : fn(...args)),
		runOwned: call => {
			if (retired) throw new Error(`${name} retired`);
			return call();
		},
		trackCallback: r => r,
		beginSession: () => () => {},
		hasPendingCallbacks: () => false,
		waitForPendingCallbacks: async () => {},
		whenCallbacksChange: () => new Promise(() => {}),
	};
}

afterEach(() => clearCustomApis());

for (const scenario of ["parent-only", "child-live", "child-retired"] as const) {
test(`parent provider: ${scenario}`, async () => {
	const tmp = TempDir.createSync("@probe-slot-");
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, tmp.join("models.yml"));
	const calls: string[] = [];
	const config = (who: string): ProviderConfigInput => ({
		baseUrl: "https://acme.example/v1",
		apiKey: "ACME_KEY",
		api: "acme-api",
		streamSimple: (() => {
			calls.push(`stream:${who}`);
			throw new Error("not used");
		}) as never,
		oauth: { name: "Acme", login: async () => "k" } as never,
		fetchDynamicModels: async () => {
			calls.push(`discover:${who}`);
			return [{ id: "acme-1", name: "Acme 1", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
		},
	});
	const parent = owner("parent");
	const child = owner("child");
	registry.registerProvider("acme", config("parent"), "ext://acme", parent);
	if (scenario !== "parent-only") registry.registerProvider("acme", config("child"), "ext://acme", child);
	if (scenario === "child-retired") child.retire();

	console.log(scenario, "customApi selectable:", getCustomApi("acme-api") !== undefined,
		"oauth entry live:", getOAuthProviderEntry("acme")?.gate?.retired === false);

	await registry.refreshRuntimeProviders("online");
	const acme = registry.getAll().filter(m => m.provider === "acme").map(m => m.id);
	console.log(scenario, "discovery calls:", JSON.stringify(calls), "acme models:", JSON.stringify(acme));
	tmp.removeSync();
	expect(acme).toContain("acme-1");
});
}

test("child withdraws its own registration (unregisterProvider with owner)", async () => {
	const tmp = TempDir.createSync("@probe-slot-");
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, tmp.join("models.yml"));
	const config: ProviderConfigInput = {
		baseUrl: "https://acme.example/v1",
		apiKey: "ACME_KEY",
		api: "openai-completions",
		models: [{ id: "acme-static", name: "Acme Static", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] as never,
		usage: { id: "acme", fetchUsage: async () => null } as never,
	};
	const parent = owner("parent");
	const child = owner("child");
	registry.registerProvider("acme", config, "ext://acme", parent);
	registry.registerProvider("acme", { ...config }, "ext://acme", child);
	registry.unregisterProvider("acme", child);
	const usageEntry = authStorage.usage.providerEntryFor("acme" as never);
	const models = registry.getAll().filter(m => m.provider === "acme").map(m => m.id);
	console.log("after child withdrawal: parent usage registration still selected:", usageEntry?.gate?.retired === false,
		"| acme models:", JSON.stringify(models));
	tmp.removeSync();
	expect(models).toContain("acme-static");
});
