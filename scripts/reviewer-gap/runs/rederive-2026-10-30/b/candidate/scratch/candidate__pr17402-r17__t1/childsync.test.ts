import { afterEach, beforeEach, test } from "bun:test";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
import { getOAuthProviderEntry } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

let authStorage: AuthStorage;
beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
});
afterEach(() => {
	clearCustomApis();
	authStorage.close();
});

const model: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "m1",
	name: "M1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const SRC = "/ext/acme.ts";

function config(tag: string): ProviderConfigInput {
	return {
		api: "acme-api",
		baseUrl: "https://acme.invalid/",
		streamSimple: (() => ({ tag }) as unknown as AssistantMessageEventStream) as never,
		models: [model],
		oauth: { name: "Acme", login: async () => `tok-${tag}` },
		usage: { id: "acme", fetchUsage: async () => null } as never,
	};
}

// Mirrors sdk.ts createAgentSessionScoped lines 2909-2918 for one session.
function sessionStartup(registry: ModelRegistry, runtime: ExtensionRuntime, tag: string) {
	registry.syncExtensionSources([SRC]);
	registry.clearSourceRegistrations(new Set([SRC]));
	registry.registerProvider("acme", config(tag), SRC, runtime);
}

const state = (registry: ModelRegistry) => ({
	customApi: getCustomApi("acme-api") ? "present" : "MISSING",
	oauth: getOAuthProviderEntry("acme") ? "present" : "MISSING",
	usageGated: registry.authStorage.usage.providerEntryFor("acme" as never)?.gate ? "runtime" : "none",
	models: registry.getAll().filter(m => m.provider === "acme").length,
});

test("subagent startup + disposal against a live parent", () => {
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	parent.beginSession();
	sessionStartup(registry, parent, "parent");
	console.log("parent only        :", state(registry));
	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();
	sessionStartup(registry, child, "child");
	console.log("parent + child     :", state(registry));
	releaseChild();
	console.log("child disposed     :", state(registry), "parent.isRetired =", parent.isRetired);
});
