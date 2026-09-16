import { afterEach, describe, expect, it } from "bun:test";
import {
	KEEP_PROVIDER_KEYS_ENV,
	providerCredentialEnvVars,
	scrubToolChildEnv,
	toolChildEnvRemove,
} from "@oh-my-pi/pi-coding-agent/exec/tool-child-env";

const savedKeep = Bun.env[KEEP_PROVIDER_KEYS_ENV];

afterEach(() => {
	if (savedKeep === undefined) {
		delete Bun.env[KEEP_PROVIDER_KEYS_ENV];
	} else {
		Bun.env[KEEP_PROVIDER_KEYS_ENV] = savedKeep;
	}
});

describe("providerCredentialEnvVars", () => {
	it("covers the baseline provider credentials the harness reads", () => {
		// Floor of the scrub denylist: if a catalog restructure stops
		// enumerating provider env vars, these names silently reappearing in
		// tool children is the regression this guards against.
		const names = providerCredentialEnvVars();
		for (const required of [
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"GEMINI_API_KEY",
			"GOOGLE_API_KEY",
			"OPENROUTER_API_KEY",
			"SECRETSD_SESSION_TOKEN_FILE",
		]) {
			expect(names).toContain(required);
		}
	});
});

describe("toolChildEnvRemove", () => {
	it("returns the denylist by default and undefined under the escape hatch", () => {
		delete Bun.env[KEEP_PROVIDER_KEYS_ENV];
		expect(toolChildEnvRemove()).toContain("ANTHROPIC_API_KEY");
		Bun.env[KEEP_PROVIDER_KEYS_ENV] = "1";
		expect(toolChildEnvRemove()).toBeUndefined();
	});

	it("treats 0 and false as unset and honors the session shell env first", () => {
		Bun.env[KEEP_PROVIDER_KEYS_ENV] = "0";
		expect(toolChildEnvRemove()).toBeDefined();
		Bun.env[KEEP_PROVIDER_KEYS_ENV] = "false";
		expect(toolChildEnvRemove()).toBeDefined();
		// A session shell env value overrides the process env, both ways.
		delete Bun.env[KEEP_PROVIDER_KEYS_ENV];
		expect(toolChildEnvRemove({ [KEEP_PROVIDER_KEYS_ENV]: "1" })).toBeUndefined();
		Bun.env[KEEP_PROVIDER_KEYS_ENV] = "1";
		expect(toolChildEnvRemove({ [KEEP_PROVIDER_KEYS_ENV]: "0" })).toBeDefined();
	});
});

describe("scrubToolChildEnv", () => {
	it("drops credentials from a replacement env while an overlay value wins", () => {
		delete Bun.env[KEEP_PROVIDER_KEYS_ENV];
		const env = scrubToolChildEnv(
			{ ANTHROPIC_API_KEY: "sk-inherited", OPENAI_API_KEY: "sk-other", KEEP_ME: "yes" },
			{ ANTHROPIC_API_KEY: "sk-explicit" },
		);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-explicit");
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.KEEP_ME).toBe("yes");
	});

	it("passes everything through under the escape hatch", () => {
		Bun.env[KEEP_PROVIDER_KEYS_ENV] = "1";
		const env = scrubToolChildEnv({ ANTHROPIC_API_KEY: "sk-inherited" });
		expect(env.ANTHROPIC_API_KEY).toBe("sk-inherited");
	});
});
