import { test } from "bun:test";
import { ModelRegistry } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/config/model-registry.ts";
import { ExtensionRuntime } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/loader.ts";
import { AuthStorage } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/session/auth-storage.ts";
const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 });
test("dynamic discovery after child retires (no source clear: child registers on top)", async () => {
	const auth = await AuthStorage.create(":memory:");
	const reg = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
	const parent = new ExtensionRuntime(); parent.beginSession();
	const child = new ExtensionRuntime(); const rel = child.beginSession();
	const cfg = (who: string) => ({ baseUrl: "https://d.example.com/v1", apiKey: "D_KEY", api: "openai-completions", fetchDynamicModels: async () => [model("dyn-" + who)] }) as never;
	reg.registerProvider("dynprov", cfg("parent"), "/ext/d.ts", parent);
	reg.registerProvider("dynprov", cfg("child"), "/ext/d.ts", child);
	rel();
	await reg.refreshRuntimeProviders("online");
	console.log("models for dynprov after child dispose:", reg.getAll().filter(m => m.provider === "dynprov").map(m => m.id));
	auth.close();
});
