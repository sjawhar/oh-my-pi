import { test } from "bun:test";
import { getCustomApi, type UsageReport } from "@oh-my-pi/pi-ai";
import { getOAuthProviderEntry } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const SOURCE = "/ext/provider-ext.ts";
const factoryFor = (label: string) => (pi: any) =>
	pi.registerProvider("probe-prov", {
		baseUrl: "https://example.invalid/v1",
		apiKey: "PROBE_KEY",
		api: "probe-custom-api",
		streamSimple: () => {
			throw new Error(`stream from ${label}`);
		},
		oauth: { name: "Probe", login: async () => "k" },
		usage: { id: "probe-prov", fetchUsage: async (): Promise<UsageReport | null> => null },
		models: [
			{
				id: "probe-model",
				name: "Probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16384,
				maxTokens: 4096,
			},
		],
	});

async function register(reg: ModelRegistry, label: string) {
	const runtime = new ExtensionRuntime();
	runtime.beginSession();
	await loadExtensionFromFactory(factoryFor(label), process.cwd(), new EventBus(), runtime, SOURCE);
	for (const { name, config, sourceId } of runtime.pendingProviderRegistrations) reg.registerProvider(name, config, sourceId, runtime);
	runtime.pendingProviderRegistrations = [];
	return runtime;
}

test("owner-scoped unregisterProvider removes the live parent's model rows and key", async () => {
	const tmp = TempDir.createSync("@probe-scoped-unreg-");
	const auth = await AuthStorage.create(tmp.join("auth.db"));
	try {
		const reg = new ModelRegistry(auth, tmp.join("models.json"));
		await register(reg, "parent");
		const child = await register(reg, "child");
		const state = () =>
			`model=${!!reg.find("probe-prov", "probe-model")} customApi=${!!getCustomApi("probe-custom-api")} oauth=${!!getOAuthProviderEntry("probe-prov")} usage=${!!auth.usage.providerFor("probe-prov" as any)} keySource=${auth.keys.source("probe-prov") !== undefined}`;
		console.log("before child unregister:", state());
		reg.unregisterProvider("probe-prov", child); // what runner.ts:888 does for the child's pi.unregisterProvider
		console.log("after  child unregister:", state());
	} finally {
		auth.close();
		tmp.removeSync();
	}
});
