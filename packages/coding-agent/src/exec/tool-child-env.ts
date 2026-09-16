import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import { providerEntries } from "@oh-my-pi/pi-catalog/compat/providers";

/**
 * Escape hatch for the tool-child credential scrub: when truthy (present and
 * not "", "0", or "false" — the `PI_DISABLE_UUTILS_BUILTINS` semantics), tool
 * subprocesses inherit the harness's provider credential env vars again.
 */
export const KEEP_PROVIDER_KEYS_ENV = "PI_KEEP_PROVIDER_KEYS";

/**
 * Credential env vars the harness reads through runtime hooks or non-catalog
 * code paths, so no catalog descriptor enumerates them:
 *
 * - `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_FOUNDRY_API_KEY` — anthropic registry
 *   env hook (`@oh-my-pi/pi-ai` `registry/hooks/env.ts`).
 * - `GOOGLE_API_KEY` — Gemini alias accepted alongside `GEMINI_API_KEY`.
 * - `GOOGLE_CLOUD_API_KEY` — Vertex hook credential.
 * - `JINA_API_KEY`, `BRAVE_API_KEY`, `TINYFISH_API_KEY`, `FIRECRAWL_API_KEY`
 *   — `LEGACY_ENV_KEYS` resolvers in `@oh-my-pi/pi-ai` `stream.ts`.
 * - `ANTHROPIC_SEARCH_API_KEY` — web-search override credential.
 * - `PERPLEXITY_COOKIES` — Perplexity search backend credential (already on
 *   the eval kernel denylist in `eval/py/runtime.ts`).
 * - `SECRETSD_SESSION_TOKEN_FILE` — session token handle for a secrets broker;
 *   leaking it to tool children defeats the broker's approval gating.
 */
const EXTRA_CREDENTIAL_ENV_VARS = [
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_SEARCH_API_KEY",
	"BRAVE_API_KEY",
	"FIRECRAWL_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"JINA_API_KEY",
	"PERPLEXITY_COOKIES",
	"SECRETSD_SESSION_TOKEN_FILE",
	"TINYFISH_API_KEY",
];

let cachedCredentialEnvVars: readonly string[] | undefined;

/**
 * Every env var the harness itself reads as a provider credential: the
 * catalog's provider `envVars` (model API keys), the compiled auth providers'
 * `env.vars` (search/tool credentials), and the hook-resolved names above.
 * This is the tool-child scrub denylist — anything the harness's own clients
 * would accept as a credential must not leak into tool subprocesses.
 */
export function providerCredentialEnvVars(): readonly string[] {
	if (cachedCredentialEnvVars) return cachedCredentialEnvVars;
	const names = new Set<string>(EXTRA_CREDENTIAL_ENV_VARS);
	for (const provider of Object.values(providerEntries())) {
		for (const name of provider.envVars ?? []) names.add(name);
	}
	for (const provider of authProviders()) {
		if (provider.env && "vars" in provider.env) {
			for (const name of provider.env.vars) names.add(name);
		}
	}
	cachedCredentialEnvVars = Array.from(names).sort();
	return cachedCredentialEnvVars;
}

/**
 * Whether the escape hatch is set: session shell env first, then process env;
 * truthy = present and not "", "0", or "false" (mirrors pi-shell's
 * `uutils_env_disabled` gate).
 */
export function keepProviderKeysInToolEnv(sessionEnv?: Record<string, string | undefined>): boolean {
	const raw = sessionEnv?.[KEEP_PROVIDER_KEYS_ENV] ?? Bun.env[KEEP_PROVIDER_KEYS_ENV];
	return !!raw && raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * The `envRemove` list for a native `Shell`/`PtySession` spawn of a tool
 * child, or `undefined` (full passthrough) when the escape hatch is set.
 */
export function toolChildEnvRemove(sessionEnv?: Record<string, string | undefined>): string[] | undefined {
	if (keepProviderKeysInToolEnv(sessionEnv)) return undefined;
	return [...providerCredentialEnvVars()];
}

/**
 * Copy an env snapshot without the provider credential env vars. For full
 * replacement envs (`Bun.spawn`-style spawns and the `sessionEnv` handed to
 * the native shell, both of which are inherited-env snapshots rather than
 * deliberate per-key config). Keys the caller deliberately set via `overlay`
 * are applied afterwards and always win, matching the native `envRemove`
 * semantics. The escape hatch is read from the snapshot itself (falling back
 * to the process env), so a copy is returned untouched (plus overlay) when it
 * is set. Never mutates `env` — callers hand in cached config objects.
 */
export function scrubToolChildEnv(
	env: Record<string, string>,
	overlay?: Record<string, string>,
): Record<string, string> {
	const scrubbed: Record<string, string> = { ...env };
	if (!keepProviderKeysInToolEnv(env)) {
		for (const name of providerCredentialEnvVars()) {
			delete scrubbed[name];
		}
	}
	if (overlay) {
		for (const key in overlay) scrubbed[key] = overlay[key];
	}
	return scrubbed;
}
