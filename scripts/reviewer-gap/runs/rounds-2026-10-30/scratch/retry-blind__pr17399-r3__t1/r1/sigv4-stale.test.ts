import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { buildModel } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/catalog/src/build";
import { clearAwsCredentialCache } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/providers/aws-credentials";
import { stream } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/stream";
import type { Api, Context, FetchImpl, OptionsForApi } from "../../../../../heads/670df28f7bf7/packages/ai/src/types";

const realSetImmediate = globalThis.setImmediate;
async function settle(): Promise<void> {
	for (let i = 0; i < 25; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

const ENV: Record<string, string | undefined> = {
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_BEDROCK_SKIP_AUTH: undefined,
	AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
	AWS_ROLE_ARN: undefined,
	AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
	AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
	AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
	AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/x/credentials",
	AWS_CONFIG_FILE: "/nonexistent/x/config",
	AWS_EC2_METADATA_DISABLED: "true",
	AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9911/credentials",
};
const saved = new Map<string, string | undefined>();
beforeEach(() => {
	for (const [k, v] of Object.entries(ENV)) {
		saved.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	clearAwsCredentialCache();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	clearAwsCredentialCache();
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const context: Context = { systemPrompt: ["t"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

it("bedrock converse: signature/credential freshness at the wire after a 60 min /pause", async () => {
	let calls = 0;
	let open = false;
	const parked = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const hold = () => {
		calls++;
		if (open || calls <= 1) return undefined; // chokepoint open, transport hold parks
		parked.resolve();
		return gate.promise;
	};
	let credExpiry = 0;
	const wire: { amzDate: string | null; nowAtWire: string; credExpiry: string }[] = [];
	const wired = Promise.withResolvers<void>();
	const fetch: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith("/credentials")) {
			credExpiry = Date.now() + 15 * 60_000;
			return Response.json({
				AccessKeyId: "AKIDHELD",
				SecretAccessKey: "secret",
				Token: "session",
				Expiration: new Date(credExpiry).toISOString(),
			});
		}
		wire.push({
			amzDate: new Headers(init?.headers).get("x-amz-date"),
			nowAtWire: new Date(Date.now()).toISOString(),
			credExpiry: new Date(credExpiry).toISOString(),
		});
		wired.resolve();
		return new Response('{"message":"Signature expired"}', { status: 403 });
	};
	const s = stream(
		buildModel({
			name: "x",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 1000,
			id: "amazon.nova-lite-v1:0",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		}),
		context,
		{ streamFirstEventTimeoutMs: 600_000, maxHttpAttempts: 1, beforeDispatch: hold, fetch } as OptionsForApi<Api>,
	);
	let result: any;
	void s.result().then(r => (result = r));
	await parked.promise;
	const pausedAt = new Date(Date.now()).toISOString();
	vi.advanceTimersByTime(60 * 60_000);
	await settle();
	open = true;
	gate.resolve();
	await wired.promise;
	for (let i = 0; i < 10 && !result; i++) await settle();
	console.log(JSON.stringify({ pausedAt, wire, holdCalls: calls, stopReason: result?.stopReason, error: result?.errorMessage?.slice(0, 80) }, null, 1));
});
