import { expect, test } from "bun:test";
import { getCustomApi, type UsageReport } from "@oh-my-pi/pi-ai";
import { getOAuthProviderEntry } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const SOURCE = "/ext/provider-ext.ts";

function factoryFor(label: string) {
	return (pi: any) => {
		pi.registerProvider("probe-prov", {
			baseUrl: "https://example.invalid/v1",
			apiKey: "PROBE_KEY",
			api: "probe-custom-api",
			streamSimple: () => {
				throw new Error(`stream from ${label}`);
			},
			oauth: { name: "Probe", login: async () => "k-" + label },
			usage: {
				id: "probe-prov",
				async fetchUsage(): Promise<UsageReport | null> {
					return { provider: "probe-prov", fetchedAt: 1, limits: [], metadata: { who: label } } as any;
				},
			},
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
	};
}

// Mirrors sdk.ts createAgentSessionScoped lines 2909-2919 for a non-restricted session.
async function startSession(modelRegistry: ModelRegistry, label: string) {
	const runtime = new ExtensionRuntime();
	const release = runtime.beginSession();
	await loadExtensionFromFactory(factoryFor(label), process.cwd(), new EventBus(), runtime, SOURCE);
	const active = [SOURCE];
	modelRegistry.syncExtensionSources(active);
	modelRegistry.clearSourceRegistrations(new Set(active));
	for (const { name, config, sourceId } of runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId, runtime);
	}
	runtime.pendingProviderRegistrations = [];
	return release;
}

function whoStreams(): string {
	const api = getCustomApi("probe-custom-api");
	if (!api) return "<no custom api>";
	try {
		api.streamSimple({} as any, {} as any, {} as any);
		return "<no throw>";
	} catch (e) {
		return String((e as Error).message);
	}
}

test("child session disposal leaves live parent without its provider", async () => {
	const tmp = TempDir.createSync("@probe-child-wipe-");
	const auth = await AuthStorage.create(tmp.join("auth.db"));
	try {
		const reg = new ModelRegistry(auth, tmp.join("models.json"));
		const releaseParent = await startSession(reg, "parent");
		console.log("parent only     :", whoStreams(), "| usage:", !!auth.usage.providerFor("probe-prov" as any), "| oauth:", !!getOAuthProviderEntry("probe-prov"));
		const releaseChild = await startSession(reg, "child");
		console.log("parent+child    :", whoStreams(), "| usage:", !!auth.usage.providerFor("probe-prov" as any), "| oauth:", !!getOAuthProviderEntry("probe-prov"));
		releaseChild();
		console.log("child disposed  :", whoStreams(), "| usage:", !!auth.usage.providerFor("probe-prov" as any), "| oauth:", !!getOAuthProviderEntry("probe-prov"));
		console.log("parent model still listed:", !!reg.find("probe-prov", "probe-model"));
		releaseParent();
	} finally {
		auth.close();
		tmp.removeSync();
	}
});
