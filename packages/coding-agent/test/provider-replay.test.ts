import { describe, expect, it } from "bun:test";
import { type AgentMessage, createRefusedTurnMessage } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage, createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import { filterSessionReplayMessages } from "@oh-my-pi/pi-coding-agent/session/provider-replay";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

describe("filterSessionReplayMessages", () => {
	// Regression: a steer queued during a refused tool-call turn made the
	// fallback retry drop the refused prompt, so the fallback model never saw it.
	it("keeps the input of a refusal a fallback retry is still answering", () => {
		const call = { type: "toolCall" as const, id: "call-refused", name: "read", arguments: { path: "a.txt" } };
		const refusal: AssistantMessage = {
			...createAssistantMessage(""),
			content: [call],
			stopReason: "error",
			stopDetails: { type: "refusal", category: "cyber" },
		};
		const placeholder: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-refused",
			toolName: "read",
			content: [{ type: "text", text: "Tool call was not executed" }],
			isError: true,
			timestamp: 2,
		};
		const prompt = user("PAYLOAD");
		const steer = user("STEER also check b.txt");
		const answer = createAssistantMessage("fallback answer");

		expect(filterSessionReplayMessages([prompt, refusal, placeholder, steer])).toEqual([prompt, steer]);
		expect(filterSessionReplayMessages([prompt, refusal, placeholder, steer, answer, user("next")])).toEqual([
			prompt,
			steer,
			answer,
			expect.objectContaining({ role: "user" }),
		]);
	});

	// Context notes are session memory; dropping them with a refused first step
	// would lose them for the rest of the context.
	it("keeps context notes that precede a refused step", () => {
		const notes = createCustomMessage(CONTEXT_NOTES_ENTRY_TYPE, "notes", false, undefined, new Date().toISOString());
		const summary = createCompactionSummaryMessage("earlier work", 1000, new Date().toISOString());
		const next = user("Reply with the single word OK.");

		expect(filterSessionReplayMessages([notes, summary, user("PAYLOAD"), createRefusedTurnMessage(3), next])).toEqual(
			[notes, summary, next],
		);
	});
});
