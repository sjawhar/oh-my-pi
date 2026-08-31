import { describe, expect, test } from "bun:test";
import { buildCustomModelOverlay } from "../../src/config/custom-models";

describe("custom model authentication", () => {
	test("leaves OAuth mode unset for an Anthropic-compatible API-key provider", () => {
		const model = buildCustomModelOverlay(
			"middleman-dev2",
			"https://middleman-dev2.hawk.staging.trajectorylabs.com/anthropic",
			"anthropic-messages",
			undefined,
			"cognito-access-token",
			undefined,
			undefined,
			undefined,
			undefined,
			{ id: "claude-haiku-4-5-wiftest" },
		);

		expect(model?.isOAuth).toBeUndefined();
	});
});
