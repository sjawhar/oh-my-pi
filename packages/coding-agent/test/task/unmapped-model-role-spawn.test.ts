/**
 * A spawn whose agent names a model role the deployment never configured.
 *
 * pi-legion's `plan-reviewer` carries `model: ["@review"]`, and `review` is not
 * one of omp's built-in roles. On a session whose settings define no
 * `modelRoles.review` the alias used to survive expansion as the literal
 * pattern `@review`, match no model, and still start a child session; the child
 * then died at its first prompt with "No model selected. Use /login, …", which
 * names neither the agent nor the role. Three dispatches failed that way on
 * 2026-10-28 and a different agent was run in the reviewer's place
 * (dispatch://INFRA-711).
 *
 * Contract defended here: such a spawn never reaches session creation, and the
 * failure the parent reads names the agent, the role and the setting that
 * answers it — and never quietly substitutes the session's own model.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function sessionModel(): Model<Api> {
	return buildModel({
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		baseUrl: "https://anthropic.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const planReviewer: AgentDefinition = {
	name: "plan-reviewer",
	description: "plan and spec reviewer",
	systemPrompt: "review the plan",
	source: "user",
	model: ["@review"],
};

describe("spawning an agent whose model role is not configured", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// `modelOverride: undefined` is a direct caller handing the raw alias
	// through; `[]` is what the task tool's policy resolution now produces for
	// the same agent. Both must refuse by name rather than start a child.
	for (const modelOverride of [undefined, [] as string[]]) {
		it(`names the missing role instead of starting a model-less session (modelOverride ${modelOverride === undefined ? "unset" : "empty"})`, async () => {
			const available = sessionModel();
			const createSession = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
				throw new Error("session created without a model");
			});
			const settings = Settings.isolated({});
			settings.setModelRole("default", "anthropic/claude-sonnet-4-5");

			const result = await runSubprocess({
				cwd: "/tmp",
				agent: planReviewer,
				task: "review this plan",
				index: 0,
				id: "unmapped-review-role",
				modelOverride,
				settings,
				parentActiveModelPattern: "anthropic/claude-sonnet-4-5",
				modelRegistry: {
					refresh: async () => {},
					getAvailable: () => [available],
					getApiKey: async () => "test-key",
				} as never,
				enableLsp: false,
			});

			expect(createSession).not.toHaveBeenCalled();
			expect(result.exitCode).toBe(1);
			expect(result.resolvedModel).toBeUndefined();
			expect(result.error).toContain("plan-reviewer");
			expect(result.error).toContain("@review");
			expect(result.error).toContain('modelRoles["review"]');
			expect(result.error).not.toContain("No model selected");
		});
	}

	it("refuses when the undefined role comes from task.agentModelOverrides, not the agent file", async () => {
		// The override outranks the agent definition, so an undefined role there
		// must not fall through to the agent's own role or to the parent's model.
		const available = sessionModel();
		const createSession = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			throw new Error("session created without a model");
		});
		const settings = Settings.isolated({
			"task.agentModelOverrides": { "plan-reviewer": "@nosuchrole" },
		});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		settings.setModelRole("review", "anthropic/claude-sonnet-4-5");

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: planReviewer,
			task: "review this plan",
			index: 0,
			id: "override-role",
			modelOverride: [],
			settings,
			parentActiveModelPattern: "anthropic/claude-sonnet-4-5",
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [available],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(createSession).not.toHaveBeenCalled();
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("@nosuchrole");
		expect(result.error).toContain('modelRoles["nosuchrole"]');
	});

	it("starts normally once the role is configured", async () => {
		const available = sessionModel();
		const createSession = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			throw new Error("stop after model resolution");
		});
		const settings = Settings.isolated({});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		settings.setModelRole("review", "anthropic/claude-sonnet-4-5");

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: planReviewer,
			task: "review this plan",
			index: 0,
			id: "mapped-review-role",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [available],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(createSession).toHaveBeenCalled();
		expect(result.error).toContain("stop after model resolution");
	});
});
