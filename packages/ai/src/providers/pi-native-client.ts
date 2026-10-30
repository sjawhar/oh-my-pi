/**
 * Client half of the pi-native auth-gateway protocol.
 *
 * Dispatches a {@link streamSimple}-shaped request to an `omp auth-gateway`
 * via `POST /v1/pi/stream`, reads the SSE event stream back, and pushes the
 * parsed events into a local {@link AssistantMessageEventStream} — the same
 * stream type every other provider client produces. Callers downstream of
 * `streamSimple` cannot tell whether the events came from a real provider
 * SDK or from a gateway hop; they consume `AssistantMessageEvent`s either
 * way.
 *
 * Activated when a {@link Model} has `transport: "pi-native"` set; the
 * dispatch hook lives in `streamSimple()` (see `../stream.ts`). Used by
 * containerized omp deployments (such as robomp slots) that
 * route every LLM call through a credential-holding sidecar so the slot
 * itself stays credential-free.
 */
import * as os from "node:os";
import { scheduler } from "node:timers/promises";
import { getAppName, getInstallId, readSseJson } from "@oh-my-pi/pi-utils";
import { AUTH_RETRY_MAX_ATTEMPTS } from "../auth-retry";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	SimpleStreamOptions,
} from "../types";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	armPreResponseTimeout,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";

/**
 * Fields that must not cross the wire — either non-serializable (functions,
 * `AbortSignal`, the provider-session `Map`) or server-controlled
 * (`apiKey`, which the gateway injects from its own credential store; the
 * client's `apiKey` is the gateway *bearer*, sent in the `Authorization`
 * header rather than the request body).
 */
const NON_WIRE_KEYS = new Set<keyof SimpleStreamOptions>([
	"signal",
	"apiKey",
	"fetch",
	"onPayload",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
	"beforeDispatch",
]);
/** Longest wait a gateway can ask of this client between hand-backs. */
const PI_NATIVE_MAX_HANDBACK_WAIT_MS = 30_000;
const PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR = "pi-native stream stalled while waiting for the next event";
const PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "pi-native stream timed out while waiting for the first event";

function isPiNativeProgressEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null || !("type" in event)) return true;
	return event.type !== "start";
}

function buildWireOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const wire: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(options)) {
		if (v === undefined) continue;
		if (NON_WIRE_KEYS.has(k as keyof SimpleStreamOptions)) continue;
		wire[k] = v;
	}
	return wire;
}

async function decodeGatewayError(response: Response): Promise<AIError.AuthGatewayError> {
	const status = response.status;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = await response.text().catch(() => "");
	}
	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (body as { error: unknown }).error;
		if (typeof err === "object" && err !== null) {
			const message = (err as { message?: unknown }).message;
			const type = (err as { type?: unknown }).type;
			return new AIError.AuthGatewayError(
				typeof message === "string" ? message : `auth-gateway ${status}`,
				status,
				response.headers,
				typeof type === "string" ? type : undefined,
			);
		}
	}
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new AIError.AuthGatewayError(
		`auth-gateway ${status}: ${text || response.statusText}`,
		status,
		response.headers,
	);
}

/**
 * Resolve the `/v1/pi/stream` endpoint URL from the model's `baseUrl`.
 * Trims a trailing slash so concatenation can't double-slash; throws when
 * the baseUrl is missing (transport=pi-native without a gateway target is
 * a configuration error, not a runtime recoverable one).
 */
function resolveStreamUrl(model: Model<Api>): string {
	if (!model.baseUrl) {
		throw new AIError.ConfigurationError(
			`pi-native transport requires \`baseUrl\` on model ${model.id} (set it on the provider config in models.yml)`,
		);
	}
	return `${model.baseUrl.replace(/\/+$/, "")}/v1/pi/stream`;
}

function buildHeaders(model: Model<Api>, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		// Usage-attribution identity: the gateway reports this request's token
		// burn to the broker under the ORIGINATING client, not the gateway host.
		// Attribution-only — the gateway never forwards x-omp-* upstream. Header
		// values must stay ISO-8859-1-safe, hence the hostname scrub.
		"x-omp-install-id": getInstallId(),
		"x-omp-hostname": os.hostname().replace(/[^\x20-\x7e]/g, "?"),
		"x-omp-app": getAppName(),
		...model.headers,
	};
	if (apiKey && !headers.Authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

/**
 * Stream a turn through an `omp auth-gateway` over the pi-native protocol.
 *
 * The returned {@link AssistantMessageEventStream} receives each parsed
 * `AssistantMessageEvent` verbatim from the gateway; the terminal `done` /
 * `error` event resolves `.result()` automatically via the base class's
 * completion check. Non-streaming consumers just call `.result()` and pay
 * for SSE framing they don't use — that overhead is dominated by provider
 * latency, so we always stream rather than maintaining a parallel
 * non-streaming path.
 */
export function streamPiNative<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStreamType {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const callerSignal = options?.signal;
		const abortTracker = createAbortSourceTracker(callerSignal);
		// Abort propagation: cancel the response body when the caller's signal
		// fires. Mirror `streamProxy`'s shape — explicit listener + finally
		// cleanup — so we don't leak listeners on the long-running case.
		let response: Response | null = null;
		const onAbort = (): void => {
			const body = response?.body;
			if (body) body.cancel("Request aborted by caller").catch(() => {});
		};
		if (callerSignal) {
			if (callerSignal.aborted) {
				stream.fail(
					callerSignal.reason instanceof Error
						? callerSignal.reason
						: new Error(String(callerSignal.reason ?? "aborted")),
				);
				return;
			}
			callerSignal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const url = resolveStreamUrl(model as Model<Api>);
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = buildHeaders(
				model as Model<Api>,
				typeof options?.apiKey === "string" ? options.apiKey : undefined,
			);
			// A caller's hold is the whole reason to own the retry: without one,
			// the gateway's own rotation is a round trip cheaper and behaves
			// identically. Gateways that predate the field ignore it and keep
			// rotating internally. The token names the authentication operation a
			// retry continues, so the gateway keeps applying its history instead of
			// restarting the policy on every hand-back.
			const buildBody = (rotationRetryToken: string | undefined): string =>
				JSON.stringify({
					modelId: `${model.provider}/${model.id}`,
					context,
					options: buildWireOptions(options),
					stream: true,
					...(options?.beforeDispatch ? { rotationRetry: "client" } : {}),
					...(rotationRetryToken ? { rotationRetryToken } : {}),
				});

			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);

			// The hand-back token the next attempt must echo, if the gateway sends
			// one. `rotationRetryToken` is what the attempt in flight was sent with.
			let rotationRetryToken: string | undefined;
			let nextRotationRetryToken: string | undefined;
			// What the gateway asked this client to wait before its next attempt:
			// zero for a rotated credential, the backoff it gave up for a declined
			// transport retry.
			let nextRetryWaitMs = 0;

			/**
			 * One pass over the wire. A `"retry"` means the gateway did a
			 * credential rotation's bookkeeping and left the inference attempt to
			 * us, with nothing published downstream yet.
			 */
			const runAttempt = async (allowRetry: boolean): Promise<"retry" | "done"> => {
				// This client owns its retries, so it owns their dispatch boundary:
				// the hold is awaited here, before the deadline below starts, so a
				// pause spends none of the response budget and a resume still
				// completes the turn. A caller that supplied a hold but not the
				// transport that carries it is covered by this and nothing else.
				await options?.beforeDispatch?.();
				abortTracker.requestSignal.throwIfAborted();
				// Bun's native fetch ceiling (~300 s of silence) is disabled so the
				// configurable first-event watchdog governs slow-prefill turns: a gateway
				// may legitimately hold headers while the upstream model thinks
				// (issue #17363). The pre-response guard bounds time-to-headers and stays
				// armed across the error-body read. Headers do not renew the budget: the
				// event iterator below waits on what the guard left of it. Each attempt
				// this loop makes is its own request, so it gets its own budget.
				const watchdog = armPreResponseTimeout(abortTracker.requestSignal, firstEventTimeoutMs);
				// `timeout` is a Bun fetch extension absent from the DOM `RequestInit`.
				const init: RequestInit & { timeout: false } = {
					method: "POST",
					headers,
					body: buildBody(rotationRetryToken),
					signal: watchdog.signal,
					timeout: false,
				};
				try {
					response = await fetchImpl(url, init);
					if (!response.ok) {
						stream.fail(await decodeGatewayError(response));
						return "done";
					}
				} finally {
					watchdog.clear();
				}
				const firstEventBudgetLeftMs = watchdog.remaining() ?? firstEventTimeoutMs;
				// Callers can truthfully inspect the gateway HTTP response, but its
				// request body is opaque here; callbacks themselves never cross the wire.
				await notifyProviderResponse(
					options,
					response,
					model,
					response.headers.get("x-request-id") ?? response.headers.get("request-id"),
				);
				if (!response.body) {
					stream.fail(
						new AIError.AuthGatewayError("auth-gateway returned empty body", response.status, response.headers),
					);
					return "done";
				}

				const source = readSseJson<PiNativeWireEvent>(
					response.body as ReadableStream<Uint8Array>,
					abortTracker.requestSignal,
				);
				const watchedSource = iterateWithIdleTimeout(source, {
					idleTimeoutMs,
					firstItemTimeoutMs: firstEventBudgetLeftMs,
					errorMessage: PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR,
					firstItemErrorMessage: PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
					onIdle: () =>
						abortTracker.abortLocally(new AIError.StreamTimeoutError(PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR)),
					onFirstItemTimeout: () =>
						abortTracker.abortLocally(new AIError.StreamTimeoutError(PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
					isProgressItem: isPiNativeProgressEvent,
				});
				// Replay safety mirrors the gateway's own rule: a leading `start`
				// is held back until the turn commits something, so a handed-back
				// attempt can be dropped whole. Once anything else has been
				// published the marker is ignored and the error stands.
				const pending: AssistantMessageEvent[] = [];
				let committed = false;
				let handedBack = false;
				let retry = false;
				let sawTerminal = false;
				for await (const frame of watchedSource) {
					const handBack = handedBackRetry(frame);
					if (handBack !== undefined) {
						handedBack = true;
						nextRotationRetryToken = handBack.token;
						nextRetryWaitMs = handBack.waitMs;
					}
					const event = isGatewayFailureFrame(frame) ? gatewayFailureEvent(model as Model<Api>, frame) : frame;
					if (!committed && event.type === "start") {
						pending.push(event);
						continue;
					}
					if (
						!committed &&
						event.type === "error" &&
						handedBack &&
						allowRetry &&
						!abortTracker.requestSignal.aborted
					) {
						// Neither this error nor the `start` before it reaches the
						// caller: the next attempt replaces them.
						pending.length = 0;
						sawTerminal = true;
						retry = true;
						continue;
					}
					for (const held of pending) stream.push(held);
					pending.length = 0;
					committed = true;
					if (event.type === "done" || event.type === "error") sawTerminal = true;
					stream.push(event);
					// `stream.push` resolves `.result()` on `done`/`error`; subsequent
					// pushes are silently dropped by the base class. We still iterate
					// to drain any trailing bytes from the wire so the underlying TCP
					// stream closes cleanly.
				}
				if (retry) return "retry";

				if (!sawTerminal) {
					const aborted = abortTracker.wasCallerAbort();
					const partial = makeSyntheticAssistant(model as Model<Api>);
					if (aborted) {
						partial.stopReason = "aborted";
						partial.errorMessage = "stream closed without terminal event";
						stream.push({ type: "error", reason: "aborted", error: partial });
					} else {
						stream.fail(
							new AIError.ProviderResponseError(
								"pi-native stream read error: stream closed before a terminal response event",
								{
									provider: model.provider,
									kind: "incomplete-stream",
								},
							),
						);
						return "done";
					}
				}
				stream.end();
				return "done";
			};

			// The gateway stops marking hand-backs once its credentials are spent
			// or its operation history says the next attempt would repeat one,
			// which is what ends this loop. The ceiling is the same one the
			// in-process auth-retry driver answers to, so a gateway that never
			// stops cannot spin a client forever.
			for (let attempt = 1; ; attempt++) {
				if ((await runAttempt(attempt < AUTH_RETRY_MAX_ATTEMPTS)) === "done") break;
				rotationRetryToken = nextRotationRetryToken;
				if (nextRetryWaitMs > 0) await scheduler.wait(nextRetryWaitMs, { signal: abortTracker.requestSignal });
			}
		} catch (err) {
			stream.fail(err);
		} finally {
			if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}

/**
 * `encodeStream`'s transport-failure envelope (`pi-native-server.ts`): an
 * `error` event carrying only `errorMessage`, because the gateway had no
 * `AssistantMessage` to attach when the upstream iterator threw.
 */
interface GatewayFailureFrame {
	type: "error";
	reason: "error";
	errorMessage?: string;
	error?: undefined;
}

/** Frames a gateway can put on the `/v1/pi/stream` wire. */
type PiNativeWireEvent = AssistantMessageEvent | GatewayFailureFrame;

function isGatewayFailureFrame(frame: PiNativeWireEvent): frame is GatewayFailureFrame {
	return frame.type === "error" && frame.error === undefined;
}

/** What a marked frame asks of this client: continue `token`, after `waitMs`. */
interface HandedBackRetry {
	token: string | undefined;
	waitMs: number;
}

/**
 * The hand-back on a terminal `error` frame marked `rotation:
 * "retryable"`: the gateway blocked or invalidated the credential this attempt
 * used, found a successor, and left the inference attempt to this client
 * because the request claimed it (`rotationRetry: "client"`). The token names
 * the authentication operation the next request continues. `undefined` when
 * the frame carries no hand-back — a gateway that rotates internally never
 * marks one, so an unmarked error is terminal as it always was.
 */
function handedBackRetry(frame: PiNativeWireEvent): HandedBackRetry | undefined {
	if (frame.type !== "error" || !("rotation" in frame) || frame.rotation !== "retryable") return undefined;
	// A gateway that marks without naming its operation gets a fresh one on the
	// next request: the history is its to keep, not ours to invent.
	const token = "rotationToken" in frame && typeof frame.rotationToken === "string" ? frame.rotationToken : undefined;
	const waitMs = "retryAfterMs" in frame && typeof frame.retryAfterMs === "number" ? frame.retryAfterMs : 0;
	// A gateway cannot park this client indefinitely by asking for a long wait.
	return { token, waitMs: Math.max(0, Math.min(waitMs, PI_NATIVE_MAX_HANDBACK_WAIT_MS)) };
}

/** Canonical `error` event for a {@link GatewayFailureFrame}, attributed to the requested model. */
function gatewayFailureEvent(model: Model<Api>, frame: GatewayFailureFrame): AssistantMessageEvent {
	const error = makeSyntheticAssistant(model);
	error.stopReason = "error";
	error.errorMessage = frame.errorMessage || "auth-gateway stream failed";
	return { type: "error", reason: "error", error };
}

function makeSyntheticAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
