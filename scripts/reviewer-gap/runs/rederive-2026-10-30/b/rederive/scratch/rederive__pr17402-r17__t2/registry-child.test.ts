import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, type AssistantMessageEventStream, clearCustomApis, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

let tempDir: string;
let authStorage: AuthStorage;
let registry: ModelRegistry;
const offlineFetch: FetchImpl = () => Promise.reject(new Error("offline"));

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `probe-rederive-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	authStorage = await AuthStorage.create(":memory:");
	registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
});
afterEach(() => {
	clearCustomApis();
	unregisterOAuthProviders("ext://shared");
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const baseModel = {
	id: "runtime-model",
	name: "Runtime Model",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
	({}) as unknown as AssistantMessageEventStream;

// Same extension factory, run once per session (parent, then a rebinding child).
function sharedConfig(log: string[], who: string): ProviderConfigInput {
	return {
		api: "custom-shared-api",
		baseUrl: "https://example.invalid/",
		streamSimple,
		apiKey: "RUNTIME_KEY",
		models: [baseModel],
		fetchDynamicModels: async () => {
			log.push(`fetch:${who}`);
			return [{ ...baseModel, id: "dynamic-model" }];
		},
		oauth: {
			name: "Shared",
			login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
			refreshToken: async c => c,
			getApiKey: c => c.access,
			modifyModels: (models: Model<Api>[]) => {
				log.push(`modify:${who}`);
				return models.map(m => (m.provider === "shared-provider" ? { ...m, name: `projected by ${who}` } : m));
			},
		},
	};
}

test("child retirement takes away the live parent's dynamic discovery and projection", async () => {
	await authStorage.credentials.set("shared-provider", {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
	});
	const log: string[] = [];
	const parent = new ExtensionRuntime();
	const releaseParent = parent.beginSession();
	const child = new ExtensionRuntime();
	const releaseChild = child.beginSession();

	registry.registerProvider("shared-provider", sharedConfig(log, "parent"), "ext://shared", parent);
	registry.registerProvider("shared-provider", sharedConfig(log, "child"), "ext://shared", child);
	await registry.refreshRuntimeProviders("online");
	console.log("both live :", {
		dynamic: !!registry.find("shared-provider", "dynamic-model"),
		name: registry.find("shared-provider", "runtime-model")?.name,
		log: [...log],
	});

	releaseChild(); // child session disposed; parent still running
	log.length = 0;
	await registry.refreshRuntimeProviders("online");
	console.log("child gone:", {
		parentRetired: parent.isRetired,
		dynamic: !!registry.find("shared-provider", "dynamic-model"),
		name: registry.find("shared-provider", "runtime-model")?.name,
		log: [...log],
	});
	releaseParent();
});
