import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

let authStorage: AuthStorage;
let dir: string;
beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebind-probe-"));
});
afterEach(() => {
	clearCustomApis();
	authStorage.close();
});

const model = {
	id: "dyn-model",
	name: "Dyn",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function config(tag: string, calls: string[]): ProviderConfigInput {
	return {
		baseUrl: "https://dyn.example.com/v1",
		apiKey: "DYN_KEY",
		api: "openai-completions",
		fetchDynamicModels: async () => {
			calls.push(tag);
			return [model];
		},
	} as ProviderConfigInput;
}

test("parent's dynamic discovery after a rebinding child retires", async () => {
	const registry = new ModelRegistry(authStorage, undefined, {
		ignoreLocalModelConfig: true,
		cacheDbPath: path.join(dir, "models.db"),
	} as never);
	const parent = new ExtensionRuntime();
	const child = new ExtensionRuntime();
	parent.beginSession();
	const releaseChild = child.beginSession();
	const calls: string[] = [];
	registry.registerProvider("dyn", config("parent", calls), "ext://dyn", parent);
	await registry.refreshRuntimeProviders("online");
	console.log("after parent register:", !!registry.find("dyn", "dyn-model"), calls);
	registry.registerProvider("dyn", config("child", calls), "ext://dyn", child);
	releaseChild();
	console.log("child retired:", child.isRetired, "parent retired:", parent.isRetired);
	await registry.refreshRuntimeProviders("online");
	console.log("after child retire + refresh:", !!registry.find("dyn", "dyn-model"), calls);
});

test("parent's oauth.modifyModels after a rebinding child retires", async () => {
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime();
	const child = new ExtensionRuntime();
	parent.beginSession();
	const releaseChild = child.beginSession();
	await authStorage.credentials.set?.("mod", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000 } as never);
	const mk = (tag: string): ProviderConfigInput =>
		({
			baseUrl: "https://mod.example.com/v1",
			api: "openai-completions",
			models: [{ ...model, id: "mod-model" }],
			oauth: {
				name: "Mod",
				login: async () => "tok",
				modifyModels: (models: { provider: string; name: string }[]) =>
					models.map(m => (m.provider === "mod" ? { ...m, name: `projected-by-${tag}` } : m)),
			},
		}) as unknown as ProviderConfigInput;
	registry.registerProvider("mod", mk("parent"), "ext://mod", parent);
	console.log("hasOAuth:", authStorage.credentials.getOAuth?.("mod") !== undefined);
	console.log("parent only:", registry.find("mod", "mod-model")?.name);
	registry.registerProvider("mod", mk("child"), "ext://mod", child);
	console.log("child registered:", registry.find("mod", "mod-model")?.name);
	releaseChild();
	await registry.refresh("offline");
	console.log("child retired, after refresh:", registry.find("mod", "mod-model")?.name);
});
