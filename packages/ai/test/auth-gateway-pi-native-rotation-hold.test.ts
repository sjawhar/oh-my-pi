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
			expect(holdsWhilePaused).toBe(1);

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
