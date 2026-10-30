/**
 * What the gateway must remember, and must refuse, while a pi-native client
 * owns its own retries.
 *
 * **The history.** One logical authentication operation — the a/b/c policy of
 * `auth-retry.ts` — is then spread over several HTTP requests instead of one
 * `streamSimpleRequest` loop. Each of those requests builds a fresh
 * `AuthRetryKeyState`, which has forgotten that this operation already spent
 * its refresh-current step and which bearers it already sent upstream. Without
 * a server-side memory the policy restarts on every hand-back: one stored
 * account whose refresh mints a new bearer turns two upstream attempts into as
 * many as the ceiling allows, and an A → B → A credential cycle never
 * terminates on the repeat. This store is that memory. The client carries only
 * an opaque token; the history stays here, where the credentials are. An
 * operation nobody comes back for is dropped by age or by the entry ceiling —
 * a client that dies holding a token costs one small record until then.
 *
 * **The refusal.** A provider SDK's own HTTP retry budget is a constructor
 * literal (`anthropic.ts` builds its client with `maxRetries: 5`), so a client
 * that owns its retries cannot stop those attempts by any option. The
 * transport wrapper below is how the gateway declines them instead, and the
 * backoff it reports is the one it took over.
 */
import * as AIError from "../error";
import type { FetchImpl, TransportWrapper } from "../types";

/** Retained operations. One small record each; the ceiling bounds a client that never returns. */
const MAX_RETRY_OPERATIONS = 512;

/** An operation nobody has continued for this long is abandoned. */
const RETRY_OPERATION_TTL_MS = 5 * 60_000;

/** What one logical authentication operation remembers across its hand-backs. */
export interface AuthGatewayRetryOperation {
	/** Bearers this operation has already put upstream, newest included. */
	readonly attempted: Set<string>;
	/**
	 * Whether the refresh-current step (`!lastChance`) has run for this
	 * operation. The in-process driver spends it once per operation; a
	 * hand-back must not buy it again, or a refresh that mints a fresh bearer
	 * every time never escalates to invalidation.
	 */
	refreshSpent: boolean;
	/** Upstream attempts this operation has authorised, against the shared ceiling. */
	attempts: number;
	/** Token the client echoes to continue it; minted on the first hand-back. */
	token?: string;
	/** Last touch, for the age bound. */
	touchedAt: number;
}

export class AuthGatewayRetryOperationStore {
	readonly #operations = new Map<string, AuthGatewayRetryOperation>();

	/**
	 * Continue the operation `token` names, or start one. An unknown or expired
	 * token starts a fresh operation rather than failing the request: the worst
	 * a forgotten history costs is the policy the gateway would have run
	 * anyway, and a client must never be stuck because the gateway restarted.
	 */
	resume(token: string | undefined, initialKey: string | undefined): AuthGatewayRetryOperation {
		const now = Date.now();
		const existing = token === undefined ? undefined : this.#operations.get(token);
		if (existing && now - existing.touchedAt <= RETRY_OPERATION_TTL_MS) {
			existing.touchedAt = now;
			if (initialKey !== undefined) existing.attempted.add(initialKey);
			return existing;
		}
		if (existing) this.#operations.delete(token as string);
		return {
			attempted: new Set(initialKey === undefined ? [] : [initialKey]),
			refreshSpent: false,
			attempts: 0,
			touchedAt: now,
		};
	}

	/**
	 * Record an attempt handed to the client and return the token it must echo.
	 * `nextKey` is the bearer that attempt will use, so a later hand-back onto
	 * a bearer this operation already tried is recognised as the cycle it is.
	 */
	handOff(operation: AuthGatewayRetryOperation, nextKey: string): string {
		operation.attempts += 1;
		operation.attempted.add(nextKey);
		operation.touchedAt = Date.now();
		operation.token ??= crypto.randomUUID();
		// Re-inserting moves the entry to the end, so insertion order is recency
		// order and the ceiling drops the operation touched longest ago.
		this.#operations.delete(operation.token);
		this.#operations.set(operation.token, operation);
		this.#evict();
		return operation.token;
	}

	/** Drop an operation a settled request will not continue. Idempotent. */
	release(operation: AuthGatewayRetryOperation): void {
		if (operation.token !== undefined) this.#operations.delete(operation.token);
	}

	/** Drop every retained operation. Called when the gateway shuts down. */
	close(): void {
		this.#operations.clear();
	}

	/** Age first, then the entry ceiling, oldest-touch first. */
	#evict(): void {
		const now = Date.now();
		for (const [token, operation] of this.#operations) {
			if (now - operation.touchedAt > RETRY_OPERATION_TTL_MS) this.#operations.delete(token);
		}
		while (this.#operations.size > MAX_RETRY_OPERATIONS) {
			const oldest = this.#operations.keys().next();
			if (oldest.done) break;
			this.#operations.delete(oldest.value);
		}
	}
}

/** First wait a client is asked for after a declined transport retry. */
const DECLINED_RETRY_BASE_DELAY_MS = 500;

/** Ceiling on that wait, matching the transport backoff the gateway gave up. */
const DECLINED_RETRY_MAX_DELAY_MS = 8_000;

/**
 * How long a client should wait before re-sending a request whose transport
 * retry was declined. The in-gateway budget it replaces backs off between its
 * own attempts; a client that re-sent immediately would hammer an upstream
 * that just asked for time.
 */
export function declinedRetryDelayMs(attempt: number): number {
	return Math.min(DECLINED_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), DECLINED_RETRY_MAX_DELAY_MS);
}

/**
 * What one request's upstream attempts have come to: how many left this
 * gateway, and whether any came back usable. The wrapper below keeps it, and
 * the route reads it to tell a failure its transport stopped short of retrying
 * from one the upstream answered.
 */
export interface UpstreamAttemptState {
	attempts: number;
	delivered: boolean;
}

/**
 * A transport wrapper that lets one upstream HTTP attempt through per gateway
 * request and declines the retries a provider SDK would make itself, so the
 * client's own hold gates them instead.
 *
 * `maxAttempts` is what the client asked this request to spend on the wire
 * (`maxHttpAttempts`, one when it named none): an attempt the client itself
 * budgeted is its own decision and is never declined, so the two budgets
 * compose instead of multiplying.
 *
 * It declines only while no attempt has returned a usable response: once one
 * has, the turn may have committed output, and a later attempt is a mid-stream
 * recovery whose work a client could not replay safely. `onDecline` runs
 * before the rejection, so the gateway marks the failure it will emit.
 *
 * Only the first transport built from it enforces anything. A transport that
 * already carries this wrapper is live — a hold supplied later joins that
 * build rather than rebuilding it — so the inference attempts and their
 * retries all pass through the first build. The one thing that runs this
 * factory again is `withoutDispatchHold`, which builds the separate unheld
 * transport that carries cleanup and credential traffic: that traffic is not
 * an inference retry, and declining it would break a workflow stop or a token
 * refresh for every held request whose first attempt failed. Later builds
 * therefore pass straight through, which also fails open rather than shut if
 * that order ever changes.
 *
 * The count and the latch live in `state`, which belongs to the request rather
 * than to this factory. One `state` per request, never shared between them.
 */
export function declineUpstreamRetries(
	state: UpstreamAttemptState,
	maxAttempts: number,
	onDecline: () => boolean,
): TransportWrapper {
	let builds = 0;
	return (fetch: FetchImpl): FetchImpl => {
		const dispatchBuild = ++builds === 1;
		if (!dispatchBuild) return fetch;
		return async (input, init) => {
			if (state.attempts >= maxAttempts && !state.delivered && onDecline()) {
				// The vendor SDK may retry this rejection on its own budget; each
				// of those lands here and is refused again, so the cost is its
				// backoff, not upstream traffic. `runtime` keeps it off the
				// transient-retry flags: the client, not this layer, owns the retry.
				throw new AIError.ProviderResponseError(
					"auth-gateway declined this retry: the client that sent the request owns it",
					{ kind: "runtime" },
				);
			}
			state.attempts += 1;
			const response = await fetch(input, init);
			if (response.ok) state.delivered = true;
			return response;
		};
	};
}
