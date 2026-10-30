import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, type AssistantMessageEventStream, clearCustomApis, type FetchImpl, getCustomApi, type Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviderEntry, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

let tempDir: string;
let authStorage: AuthStorage;
let registry: ModelRegistry;
const offlineFetch: FetchImpl = () => Promise.reject(new Error("offline"));
const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "runtime-model",
	name: "Runtime Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const streamSimple = (() => ({}) as unknown as AssistantMessageEventStream) as NonNullable<ProviderConfigInput["streamSimple"]>;

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `probe-rebind-${Date.now()}-${Math.random()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	authStorage = await AuthStorage.create(":memory:");
	registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
});
afterEach(() => {
	clearCustomApis();
	unregisterOAuthProviders("ext://same");
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// Parent session and a subagent that rebinds the same extension: two runtimes, one shared ModelRegistry.
function makeConfig(tag: string): ProviderConfigInput {
	return {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "RUNTIME_KEY",
		api: "probe-dyn-api",
		streamSimple,
		fetchDynamicModels: async () => [{ ...baseModel, id: `dynamic-${tag}` }],
	};
}

test("parent's dynamic discovery after subagent disposal", async () => {
	const parent = new ExtensionRuntime();
	const releaseParent = parent.beginSession();
	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();

	registry.registerProvider("acme", makeConfig("parent"), "ext://same", parent);
	await registry.refreshRuntimeProviders("online");
	console.log("parent only:", registry.getAll().filter(m => m.provider === "acme").map(m => m.id));

	registry.registerProvider("acme", makeConfig("child"), "ext://same", child);
	await registry.refreshRuntimeProviders("online");
	console.log("with child:", registry.getAll().filter(m => m.provider === "acme").map(m => m.id));

	releaseChild(); // subagent disposed
	console.log("parent retired?", parent.isRetired, "child retired?", child.isRetired);
	console.log("custom api still answers (stacked):", getCustomApi("probe-dyn-api") !== undefined);
	await registry.refreshProvider("acme", "online");
	console.log("after child dispose:", registry.getAll().filter(m => m.provider === "acme").map(m => m.id));
	releaseParent();
});

test("parent's modifyModels after subagent disposal", async () => {
	await authStorage.credentials.set("filt", {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: Date.now() + 60_000,
	});
	const parent = new ExtensionRuntime();
	const releaseParent = parent.beginSession();
	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();
	const cfg = (): ProviderConfigInput => ({
		api: "probe-filt-api",
		baseUrl: "https://example.invalid/",
		streamSimple,
		models: [baseModel],
		oauth: {
			name: "Filt",
			login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
			refreshToken: async c => c,
			getApiKey: c => c.access,
			modifyModels: (models: Model<Api>[]) => models.filter(m => m.provider !== "anthropic"),
		},
	});
	registry.registerProvider("filt", cfg(), "ext://same", parent);
	console.log("parent only, anthropic rows:", registry.getAll().filter(m => m.provider === "anthropic").length);
	registry.registerProvider("filt", cfg(), "ext://same", child);
	releaseChild();
	await registry.refresh("offline" as never);
	console.log("oauth entry gate retired?", getOAuthProviderEntry("filt")?.gate?.retired);
	console.log("after child dispose, anthropic rows:", registry.getAll().filter(m => m.provider === "anthropic").length);
	releaseParent();
});
