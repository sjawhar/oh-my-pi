import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, getCustomApi } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { createInMemoryAuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/test/helpers/agent-session-setup";

test("child unregisterProvider(name, childOwner) leaves parent's registration", () => {
	const auth = createInMemoryAuthStorage();
	const registry = new ModelRegistry(auth, path.join(os.tmpdir(), `unreg-${Date.now()}.yml`));
	const config = () => ({
		baseUrl: "https://x.example/v1",
		apiKey: "KEY",
		api: "unreg-api",
		streamSimple: () => createAssistantMessageEventStream(),
		usage: { id: "unreg", async fetchUsage() { return null; } },
		models: [{ id: "m", name: "m", reasoning: false, input: ["text"] as ("text")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
	});
	const parent = new ExtensionRuntime();
	const child = new ExtensionRuntime();
	parent.beginSession();
	child.beginSession();
	registry.registerProvider("unreg", config() as never, "src", parent);
	registry.registerProvider("unreg", config() as never, "src", child);
	registry.unregisterProvider("unreg", child);
	const state = {
		model: !!registry.find("unreg", "m"),
		usage: !!auth.usage.providerFor("unreg"),
		api: !!getCustomApi("unreg-api"),
		keySource: auth.keys.source("unreg") !== undefined,
	};
	console.log(JSON.stringify(state));
	expect(state).toEqual({ model: true, usage: true, api: true, keySource: true });
	auth.close();
});
