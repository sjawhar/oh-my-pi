import { afterEach, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/auth-storage";
import type { ProviderCallGate } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/auth/provider-gate";
import type { UsageProvider, UsageReport } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/usage";

function oauthRow(id: number, provider: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
	};
	return { id, provider, credential, disabledCause: null };
}

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: () => rows,
		updateAuthCredential() {},
		deleteAuthCredential: async () => false,
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => rows,
		upsertAuthCredential: async () => rows,
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry || entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function makeGate() {
	let retired = false;
	const gate: ProviderCallGate = {
		get retired() {
			return retired;
		},
		run<R>(call: () => R): R {
			if (retired) throw new Error("session retired");
			return call();
		},
	};
	return { gate, retire: () => void (retired = true) };
}

const report = (source: string): UsageReport => ({
	provider: "ext-shared",
	fetchedAt: Date.now(),
	limits: [],
	metadata: { accountId: "account-1", source },
});

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const s of storages.splice(0)) s.close();
});

async function scenario(childOutcome: "fail" | "succeed", selectBeforeSettle = false) {
	const storage = new AuthStorage(makeStore([oauthRow(1, "ext-shared")]), { usageProviderResolver: () => undefined });
	storages.push(storage);
	await storage.credentials.reload();
	const parent = makeGate();
	const child = makeGate();
	let parentCalls = 0;
	const parentProvider: UsageProvider = {
		id: "ext-shared",
		fetchUsage: async () => {
			parentCalls++;
			return report("parent");
		},
	};
	const childFetch = Promise.withResolvers<UsageReport | null>();
	let childStarted!: () => void;
	const started = new Promise<void>(r => (childStarted = r));
	const childProvider: UsageProvider = {
		id: "ext-shared",
		fetchUsage: () => {
			childStarted();
			return childFetch.promise;
		},
	};
	storage.usage.setProvider("ext-shared", parentProvider, undefined, parent.gate);
	storage.usage.setProvider("ext-shared", childProvider, undefined, child.gate);

	const first = storage.usage.reports();
	await started; // T1: child's fetch admitted and running
	child.retire(); // child session disposed while its fetch is in flight
	if (selectBeforeSettle) storage.usage.providerFor("ext-shared"); // control: selection prunes before the probe settles
	if (childOutcome === "fail") childFetch.reject(new Error("upstream 503"));
	else childFetch.resolve(report("child"));
	const firstResult = await first;

	// T2: child is retired; the parent registration answers now.
	const second = await storage.usage.reports();
	return {
		first: firstResult?.map(r => r.metadata?.source),
		second: second?.map(r => r.metadata?.source),
		parentCalls,
	};
}

it("child succeeds then retires mid-fetch: parent asked on next poll", async () => {
	const r = await scenario("succeed");
	console.log("succeed path:", JSON.stringify(r));
	expect(r.parentCalls).toBe(1);
});

it("child fails then retires mid-fetch: parent should be asked on next poll", async () => {
	const r = await scenario("fail");
	console.log("fail path:", JSON.stringify(r));
	expect(r.parentCalls).toBe(1);
});

it("control: same failure, but selection observed the retirement before the probe settled", async () => {
	const r = await scenario("fail", true);
	console.log("fail path, pruned first:", JSON.stringify(r));
	expect(r.parentCalls).toBe(1);
});
