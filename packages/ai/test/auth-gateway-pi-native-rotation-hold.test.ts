/**
 * Who makes the next inference attempt when a `pi-native` turn's credential
 * rotates.
 *
 * `StreamOptions.beforeDispatch` is the caller's hold on every request this
 * layer puts on the wire — `/pause` is what engages it. Against a direct
 * provider the hold covers each rotated-credential attempt too, because every
 * attempt leaves through the same client. Behind an `omp auth-gateway` the
 * first attempt was the client's and every rotation after it was the
 * gateway's, on the far side of a connection authorised when it was opened:
 * a paused session still paid a provider.
 *
 * A client that carries a hold now says so on the wire and the gateway hands
 * the attempt back. The credential bookkeeping — usage-limit block, credential
 * invalidation, sibling selection — stays server-side; the inference attempt
 * does not.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { declineUpstreamRetries } from "@oh-my-pi/pi-ai/auth-gateway/retry-operations";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const BEARER = "gw-test-token";

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

/** The client's view of the gateway: one model whose transport is the hop itself. */
function gatewayModel(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		transport: "pi-native",
	} as ModelSpec<"anthropic-messages">);
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

interface GatewayOptions {
	/** Runs before every upstream call, so a test can engage its hold in the rotation window. */
	onAttempt?: (attempt: number) => void;
	/** Credentials the gateway may rotate through. */
	keys?: string[];
	/** The pre-emit failure the first upstream attempt raises. */
	firstFailure?: () => Error;
}

/**
 * A gateway whose upstream fails the first inference attempt before emitting
 * anything — the only failure its credential resolver rotates on — and answers
 * every attempt after it with the bearer it was handed.
 */
async function bootGateway(options: GatewayOptions = {}) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pause-rotation-"));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	const storage = new AuthStorage(store);
	await storage.credentials.set(
		"mock",
		(options.keys ?? ["quota-key", "healthy-key"]).map(key => ({ type: "api_key" as const, key })),
	);
	const markReached = spyOn(storage.limits, "markReached");
	let attempt = 0;
	const mock = createMockModel({
		provider: "mock",
		id: "gateway-quota-model",
		handler: (_context, streamOptions) => {
			attempt += 1;
			options.onAttempt?.(attempt);
			if (attempt === 1) {
				throw (
					options.firstFailure?.() ??
					new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" })
				);
			}
			return { content: [`ok:${streamOptions?.apiKey ?? "missing"}`] };
		},
	});
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [BEARER],
		storage,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		url: handle.url,
		mock,
		markReached,
		close: async () => {
			markReached.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

afterEach(() => {
	clearCustomApis();
	unregisterOAuthProviders("gateway-hold-test");
});

describe("pi-native credential rotation and the caller's dispatch hold", () => {
	it("makes no upstream attempt while the hold is engaged, and still rotates after it opens", async () => {
		let paused = false;
		let holdsWhilePaused = 0;
		const upstreamWhilePaused: number[] = [];
		const resumed = Promise.withResolvers<void>();
		// The two outcomes this races: the gateway rotating on its own (the
		// defect) or the client parking its own retry on the hold (the
		// contract). Both are events the test raises, so nothing waits on a clock.
		const parked = Promise.withResolvers<"held">();
		const rotatedBehindTheHold = Promise.withResolvers<"rotated">();
		const harness = await bootGateway({
			onAttempt: attempt => {
				if (attempt === 1) {
					paused = true;
					return;
				}
				if (paused) {
					upstreamWhilePaused.push(attempt);
					rotatedBehindTheHold.resolve("rotated");
				}
			},
		});
		const beforeDispatch = async (): Promise<void> => {
			if (!paused) return;
			holdsWhilePaused += 1;
			parked.resolve("held");
			await resumed.promise;
		};
		let httpRequests = 0;
		const countingFetch: FetchImpl = (input, init) => {
			httpRequests += 1;
			return fetch(input as string, init);
		};
		try {
			const stream = streamSimple(gatewayModel(harness.url), baseContext, {
				apiKey: BEARER,
				fetch: countingFetch,
				sessionId: "gw-pause-rotation",
				beforeDispatch,
			});
			const outcome = await Promise.race([parked.promise, rotatedBehindTheHold.promise]);

			expect(outcome).toBe("held");
			expect(upstreamWhilePaused).toEqual([]);
			expect(harness.mock.calls).toHaveLength(1);
			// How often a transport asks a hold per attempt is that layer's
			// business; that the held attempt entered it is this one's.
			expect(holdsWhilePaused).toBeGreaterThanOrEqual(1);

			// The rotation is held, not cancelled: the resume finishes the same
			// turn on the sibling credential.
			paused = false;
			resumed.resolve();
			const message = await stream.result();
			const keys = harness.mock.calls.map(call =>
				typeof call.options?.apiKey === "string" ? call.options.apiKey : "non-static",
			);
			expect(keys).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			expect(message.stopReason).toBe("stop");
			expect(textOf(message)).toBe(`ok:${keys[1]}`);
			// One client dispatch per upstream attempt.
			expect(httpRequests).toBe(2);
			// The credential bookkeeping stayed the gateway's.
			expect(harness.markReached.mock.calls).toHaveLength(1);
			expect(harness.markReached.mock.calls[0]?.[2]?.apiKey).toBe(keys[0]);
		} finally {
			resumed.resolve();
			await harness.close();
		}
	});

	it("keeps the rotation inside the gateway for a caller with no hold", async () => {
		const harness = await bootGateway();
		let httpRequests = 0;
		const countingFetch: FetchImpl = (input, init) => {
			httpRequests += 1;
			return fetch(input as string, init);
		};
		try {
			const message = await streamSimple(gatewayModel(harness.url), baseContext, {
				apiKey: BEARER,
				fetch: countingFetch,
				sessionId: "gw-no-hold",
			}).result();
			const keys = harness.mock.calls.map(call =>
				typeof call.options?.apiKey === "string" ? call.options.apiKey : "non-static",
			);
			expect(keys).toHaveLength(2);
			expect(new Set(keys).size).toBe(2);
			expect(message.stopReason).toBe("stop");
			expect(httpRequests).toBe(1);
		} finally {
			await harness.close();
		}
	});

	it("does not hand back an attempt that would reuse the credential that just failed", async () => {
		// The only credential, rejected: the gateway's refresh step resolves the
		// same bearer. Handing that back would spin the client on a credential
		// that cannot succeed — one upstream attempt per pass, up to the retry
		// ceiling — where the in-process driver refuses it after one.
		const harness = await bootGateway({
			keys: ["only-key"],
			firstFailure: () => new ProviderHttpError("Invalid API key", 401, { code: "invalid_api_key" }),
		});
		let httpRequests = 0;
		const countingFetch: FetchImpl = (input, init) => {
			httpRequests += 1;
			return fetch(input as string, init);
		};
		try {
			const message = await streamSimple(gatewayModel(harness.url), baseContext, {
				apiKey: BEARER,
				fetch: countingFetch,
				sessionId: "gw-single-credential",
				beforeDispatch: () => {},
			}).result();
			expect(message.stopReason).toBe("error");
			expect(harness.mock.calls).toHaveLength(1);
			expect(httpRequests).toBe(1);
		} finally {
			await harness.close();
		}
	});
});

function sseResponse(frames: unknown[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function baseAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const startEvent: AssistantMessageEvent = { type: "start", partial: baseAssistant() };

/**
 * The two wire shapes the client must handle without a live gateway: an error
 * carrying no retry marker — what every gateway built before this change
 * answers with — and one carrying the marker after output already committed.
 */
describe("pi-native client retry marker", () => {
	it("surfaces an unmarked gateway error without a second request", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = (async () => {
			requests += 1;
			return sseResponse([startEvent, { type: "error", reason: "error", errorMessage: "Generic provider failure" }]);
		}) as FetchImpl;
		const message = await streamSimple(gatewayModel("http://gateway.invalid"), baseContext, {
			apiKey: BEARER,
			fetch: fetchImpl,
			beforeDispatch: () => {},
		}).result();
		expect(requests).toBe(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Generic provider failure");
	});

	it("does not replay a marked error once output has committed", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = (async () => {
			requests += 1;
			return sseResponse([
				startEvent,
				{ type: "text_delta", contentIndex: 0, delta: "partial answer", partial: baseAssistant() },
				{
					type: "error",
					reason: "error",
					errorMessage: "Generic provider failure",
					rotation: "retryable",
				},
			]);
		}) as FetchImpl;
		const message = await streamSimple(gatewayModel("http://gateway.invalid"), baseContext, {
			apiKey: BEARER,
			fetch: fetchImpl,
			beforeDispatch: () => {},
		}).result();
		expect(requests).toBe(1);
		expect(message.stopReason).toBe("error");
	});
});

describe("an authentication operation spread over several requests", () => {
	/**
	 * One stored account, both of its tokens rejected. The in-process driver
	 * spends its refresh once and then invalidates; a hand-back that forgot
	 * that history would refresh again on every pass, minting a fresh bearer
	 * each time and never reaching the invalidation — 64 upstream attempts
	 * where there should be two.
	 */
	for (const clientOwnsRetry of [false, true]) {
		it(`spends one refresh and then invalidates, client-owned=${clientOwnsRetry}`, async () => {
			let refreshed = 0;
			registerOAuthProvider({
				id: "gateway-hold-oauth",
				name: "hold test",
				sourceId: "gateway-hold-test",
				async login() {
					return { access: "token-0", refresh: "refresh-0", expires: Date.now() + 3_600_000 };
				},
				async refreshToken(credential) {
					refreshed += 1;
					return {
						...credential,
						access: `token-${refreshed}`,
						refresh: `refresh-${refreshed}`,
						expires: Date.now() + 3_600_000,
					};
				},
				getApiKey: credential => credential.access,
			});
			registerMockApi();
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-hold-oauth-"));
			const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "auth.db")));
			await storage.credentials.set("gateway-hold-oauth", {
				type: "oauth",
				access: "token-0",
				refresh: "refresh-0",
				expires: Date.now() + 3_600_000,
			});
			const mock = createMockModel({
				provider: "gateway-hold-oauth",
				handler: () => {
					throw new ProviderHttpError("Invalid API key", 401, { code: "invalid_api_key" });
				},
			});
			const invalidated = spyOn(storage.limits, "invalidateMatching");
			const handle = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: [BEARER],
				storage,
				resolveModel: () => mock.model,
				version: "test",
			});
			try {
				const message = await streamSimple(gatewayModel(handle.url), baseContext, {
					apiKey: BEARER,
					sessionId: "gw-oauth-operation",
					...(clientOwnsRetry ? { beforeDispatch: () => {} } : {}),
				}).result();
				expect(message.stopReason).toBe("error");
				expect(mock.calls).toHaveLength(2);
				expect(refreshed).toBe(1);
				// The invalidation must name the bearer the failing attempt sent,
				// not the one storage has already replaced.
				expect(invalidated.mock.calls.map(call => call[1])).toEqual(["token-1"]);
			} finally {
				invalidated.mockRestore();
				await handle.close();
				storage.close();
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
	}

	it("does not charge the hold's wait to the response deadline", async () => {
		// The watchdog is a platform timer behind a real HTTP fetch: there is no
		// seam to drive it from fake time, so this waits for real.
		let paused = false;
		const held = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<void>();
		const harness = await bootGateway({
			onAttempt: attempt => {
				if (attempt === 1) paused = true;
			},
		});
		try {
			const stream = streamSimple(gatewayModel(harness.url), baseContext, {
				apiKey: BEARER,
				sessionId: "gw-deadline",
				streamFirstEventTimeoutMs: 20,
				beforeDispatch: async () => {
					if (!paused) return;
					held.resolve();
					await resumed.promise;
				},
			});
			await held.promise;
			await Bun.sleep(60);
			paused = false;
			resumed.resolve();
			const message = await stream.result();
			expect(message.stopReason).toBe("stop");
			expect(harness.mock.calls).toHaveLength(2);
		} finally {
			resumed.resolve();
			await harness.close();
		}
	});

	it("holds its own retry when the caller's fetch carries no hold", async () => {
		// `streamPiNative` is exported: a caller can supply a hold with an
		// ordinary fetch. The ownership it claims on the wire has to be backed
		// by this client awaiting that hold itself.
		let paused = false;
		let holds = 0;
		const resumed = Promise.withResolvers<void>();
		const parked = Promise.withResolvers<void>();
		const harness = await bootGateway({
			onAttempt: attempt => {
				if (attempt === 1) paused = true;
			},
		});
		try {
			const stream = streamPiNative(gatewayModel(harness.url), baseContext, {
				apiKey: BEARER,
				sessionId: "gw-direct-client",
				beforeDispatch: async () => {
					if (!paused) return;
					holds += 1;
					parked.resolve();
					await resumed.promise;
				},
			});
			await parked.promise;
			expect(holds).toBeGreaterThanOrEqual(1);
			expect(harness.mock.calls).toHaveLength(1);
			paused = false;
			resumed.resolve();
			const message = await stream.result();
			expect(message.stopReason).toBe("stop");
			expect(harness.mock.calls).toHaveLength(2);
		} finally {
			resumed.resolve();
			await harness.close();
		}
	});
});

describe("the provider transport's own retries", () => {
	/**
	 * A transient upstream failure the provider transport would re-send itself.
	 * For a client that owns its retries the gateway declines that attempt and
	 * hands it back, so the client's hold gates it; for any other client it
	 * keeps re-sending, as it always has.
	 */
	for (const clientOwnsRetry of [false, true]) {
		it(`declines the transport's own retry only for a client that owns it: owned=${clientOwnsRetry}`, async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-transport-"));
			const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "auth.db")));
			await storage.credentials.set("transport-test", [{ type: "api_key", key: "only-key" }]);
			const upstream = buildModel({
				id: "model",
				name: "transport test",
				api: "openai-completions",
				provider: "transport-test",
				baseUrl: "http://upstream.invalid/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 1000,
			} as ModelSpec<"openai-completions">);
			let upstreamAttempts = 0;
			const upstreamFetch: FetchImpl = async () => {
				upstreamAttempts += 1;
				if (upstreamAttempts === 1) {
					return Response.json(
						{ error: { message: "temporarily unavailable", type: "server_error" } },
						{ status: 503, headers: { "retry-after-ms": "1" } },
					);
				}
				const chunks = [
					{
						id: "r",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
					},
					{ id: "r", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			};
			const handle = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: [BEARER],
				storage,
				resolveModel: () => upstream,
				version: "test",
				fetch: upstreamFetch,
			});
			let httpRequests = 0;
			const countingFetch: FetchImpl = (input, init) => {
				httpRequests += 1;
				return fetch(input as string, init);
			};
			try {
				const message = await streamSimple(gatewayModel(handle.url), baseContext, {
					apiKey: BEARER,
					fetch: countingFetch,
					sessionId: "gw-transport-retry",
					...(clientOwnsRetry ? { beforeDispatch: () => {} } : {}),
				}).result();
				expect(message.stopReason).toBe("stop");
				expect(upstreamAttempts).toBe(2);
				// One client dispatch per upstream attempt when the client owns the
				// retry; the gateway's own transport re-send otherwise.
				expect(httpRequests).toBe(clientOwnsRetry ? 2 : 1);
			} finally {
				await handle.close();
				storage.close();
				await fs.rm(dir, { recursive: true, force: true });
			}
			// A declined attempt is refused before the wire, but the transport
			// that wanted it still spends its own backoff on the refusals, so a
			// hand-back arrives seconds after the failure it answers.
		}, 30_000);
	}
});

describe("the declined-retry wrapper's per-request state", () => {
	it("keeps counting when the transport builds it more than once", async () => {
		// The transport composes a wrapper into more than one build of the same
		// request's fetch — a later hold joins a build in place, `withoutDispatchHold`
		// makes a separate unheld one — so the factory can run again. The count
		// that decides a decline belongs to the request, not to a build: state
		// held inside the factory would reset and never decline.
		const state = { attempts: 0, delivered: false };
		let declines = 0;
		const wrap = declineUpstreamRetries(state, 1, () => {
			declines += 1;
			return true;
		});
		const upstream: FetchImpl = async () => Response.json({ error: "nope" }, { status: 503 });
		const first = wrap(upstream);
		expect((await first("http://upstream.invalid", { method: "POST" })).status).toBe(503);
		const second = wrap(upstream);
		await expect(second("http://upstream.invalid", { method: "POST" })).rejects.toThrow("declined this retry");
		expect(declines).toBe(1);
		expect(state.attempts).toBe(1);
	});

	it("stops declining once an attempt has come back usable", async () => {
		const state = { attempts: 0, delivered: false };
		const wrap = declineUpstreamRetries(state, 1, () => true);
		const upstream: FetchImpl = async () => new Response("ok", { status: 200 });
		const fetchImpl = wrap(upstream);
		expect((await fetchImpl("http://upstream.invalid", { method: "POST" })).status).toBe(200);
		// A mid-stream recovery after a usable response is never a hand-back.
		expect((await fetchImpl("http://upstream.invalid", { method: "POST" })).status).toBe(200);
		expect(state.delivered).toBe(true);
	});
});
