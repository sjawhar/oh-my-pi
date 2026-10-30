import { afterEach, beforeEach, test } from "bun:test";
import { clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
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

test("child's gated unregisterProvider vs parent's registration", () => {
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	const child = new ExtensionRuntime();
	parent.beginSession();
	child.beginSession();
	const mk = (): ProviderConfigInput =>
		({
			baseUrl: "https://sib.example.com/v1",
			apiKey: "SIB_KEY",
			api: "sib-custom-api",
			streamSimple: () => ({}) as never,
			models: [
				{
					id: "sib-model",
					name: "Sib",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
			oauth: { name: "Sib", login: async () => "tok" },
		}) as unknown as ProviderConfigInput;
	registry.registerProvider("sib", mk(), "ext://sib", parent);
	registry.registerProvider("sib", mk(), "ext://sib", child);
	registry.unregisterProvider("sib", child);
	console.log({
		parentRetired: parent.isRetired,
		model: !!registry.find("sib", "sib-model"),
		apiKeySource: registry.authStorage.keys.source("sib") !== undefined,
		customApi: !!getCustomApi("sib-custom-api"),
		oauth: !!getOAuthProviderEntry("sib"),
	});
});
