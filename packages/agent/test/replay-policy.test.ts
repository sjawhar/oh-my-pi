import { describe, expect, it } from "bun:test";
import { type AgentMessage, filterProviderReplayMessages } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createAssistantMessage, createUserMessage } from "./helpers";

function refusal(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		...createAssistantMessage(content, "error"),
		stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
		errorMessage: "Refusal (cyber): Classifier declined this turn.",
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("filterProviderReplayMessages", () => {
	// Regression: the input that drew a refusal was resent on every later
	// request, so one refusal made the provider refuse every following turn.
	it("leaves out only the refused step's input once a later prompt follows it", () => {
		const history: AgentMessage[] = [
			createUserMessage("first question"),
			createAssistantMessage([{ type: "text", text: "first answer" }]),
			createUserMessage("PAYLOAD"),
			refusal(),
			createUserMessage("second question"),
			createAssistantMessage([{ type: "text", text: "second answer" }]),
			createUserMessage("third question"),
		];

		expect(filterProviderReplayMessages(history)).toEqual([
			history[0],
			history[1],
			history[4],
			history[5],
			history[6],
		]);
	});

	// A dropped tool result would orphan its call (providers reject that), and a
	// resent one would draw the refusal again.
	it("keeps a refused tool read paired with its call but withholds the result's content", () => {
		const call = { type: "toolCall" as const, id: "call-read", name: "read", arguments: { path: "payload.txt" } };
		const history: AgentMessage[] = [
			createUserMessage("read payload.txt"),
			createAssistantMessage([call], "toolUse"),
			toolResult("call-read", "PAYLOAD"),
			refusal(),
			createUserMessage("Reply with the single word OK."),
		];

		const replayed = filterProviderReplayMessages(history);

		expect(replayed.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		const withheld = replayed[2] as ToolResultMessage;
		expect(withheld.toolCallId).toBe("call-read");
		expect(JSON.stringify(withheld.content)).not.toContain("PAYLOAD");
		// Providers reject a tool result with no content.
		expect(withheld.content.some(block => block.type === "text" && block.text.trim().length > 0)).toBe(true);
	});

	it("adds up consecutive refused steps", () => {
		const history: AgentMessage[] = [
			createUserMessage("PAYLOAD one"),
			refusal(),
			createUserMessage("PAYLOAD two"),
			refusal(),
			createUserMessage("Reply with the single word OK."),
		];

		expect(filterProviderReplayMessages(history)).toEqual([history[4]]);
	});

	// A retry of the refused step (a fallback model, `/retry`) must still send
	// the input; only later input supersedes it.
	it("keeps a refused step's input while nothing has superseded it", () => {
		const history: AgentMessage[] = [
			createUserMessage("first question"),
			createAssistantMessage([{ type: "text", text: "first answer" }]),
			createUserMessage("PAYLOAD"),
			refusal(),
		];

		expect(filterProviderReplayMessages(history)).toEqual(history.slice(0, 3));
	});

	// A step a retry answered is ordinary history; dropping its input would
	// leave the accepted reply answering nothing.
	it("keeps the input of a refused step a later reply answered, dropping the refusal's own tool calls", () => {
		const call = { type: "toolCall" as const, id: "call-refused", name: "read", arguments: { path: "a.txt" } };
		const history: AgentMessage[] = [
			createUserMessage("PAYLOAD"),
			refusal([call]),
			toolResult("call-refused", "Tool was not executed"),
			createAssistantMessage([{ type: "text", text: "answer from the fallback model" }]),
			createUserMessage("next question"),
		];

		expect(filterProviderReplayMessages(history)).toEqual([history[0], history[3], history[4]]);
	});

	// The compaction summary is the session's memory of everything before it,
	// not input of the step that followed it.
	it("keeps a compaction summary that precedes a refused step", () => {
		const summary = createCompactionSummaryMessage("earlier work", 1000, new Date().toISOString());
		const history: AgentMessage[] = [
			summary,
			createUserMessage("PAYLOAD"),
			refusal(),
			createUserMessage("Reply with the single word OK."),
		];

		expect(filterProviderReplayMessages(history)).toEqual([summary, history[3]]);
	});
});
