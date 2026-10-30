import { afterEach, beforeEach, expect, test } from "bun:test";
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

const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "bootstrap",
	name: "Bootstrap",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const streamSimple = (() => ({}) as unknown as AssistantMessageEventStream) as NonNullable<
	ProviderConfigInput["streamSimple"]
>;

function config(tag: string): ProviderConfigInput {
	return {
		api: "acme-api",
		baseUrl: "https://acme.invalid/",
		apiKey: "ACME_KEY",
		streamSimple,
		models: [baseModel],
		oauth: {
			name: "Acme",
			login: async () => "tok",
			getApiKey: c => c.access,
			modifyModels: models =>
				models.map(m => (m.provider === "acme" ? { ...m, id: `projected-by-${tag}`, name: tag } : m)),
		},
	};
}

const ids = (r: ModelRegistry) =>
	r
		.getAll()
		.filter(m => m.provider === "acme")
		.map(m => m.id);

test("child retirement drops the live parent's modifyModels projection", async () => {
	await authStorage.credentials.set("acme", {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: Date.now() + 600_000,
	});
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	const releaseParent = parent.beginSession();
	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();

	registry.registerProvider("acme", config("parent"), "ext://acme", parent);
	console.log("parent only:", ids(registry));
	registry.registerProvider("acme", config("child"), "ext://acme", child);
	console.log("parent+child:", ids(registry));
	releaseChild();
	await registry.refresh("offline");
	console.log("after child retired, parent live (parent.isRetired=%s):", parent.isRetired, ids(registry));
	console.log("oauth entry still answers (parent):", getOAuthProviderEntry("acme")?.gate?.retired === false);
	releaseParent();
});

test("child pi.unregisterProvider removes the live parent's key + models", async () => {
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	parent.beginSession();
	const child = new ExtensionRuntime();
	child.beginSession();
	const plain = (k: string): ProviderConfigInput => ({
		api: "openai-completions",
		baseUrl: "https://acme.invalid/v1",
		apiKey: k,
		models: [baseModel],
		usage: { id: "acme", fetchUsage: async () => null } as never,
	});
	registry.registerProvider("acme", plain("PARENT_KEY"), "ext://acme", parent);
	registry.registerProvider("acme", plain("CHILD_KEY"), "ext://acme", child);
	console.log("before child unregister:", ids(registry), "key source:", registry.authStorage.keys.source("acme"));
	registry.unregisterProvider("acme", child);
	console.log(
		"after child unregister (parent live):",
		ids(registry),
		"key source:",
		registry.authStorage.keys.source("acme"),
		"usage entry:",
		registry.authStorage.usage.providerEntryFor("acme" as never)?.gate === undefined ? "none/host" : "parent-gated",
	);
});
