import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomMessage } from "./compaction/messages";
import refusedToolResultPrompt from "./prompts/refused-tool-result.md" with { type: "text" };
import type { AgentMessage } from "./types";

/**
 * Custom message type a harness leaves where it removed a refused reply from
 * history after recovery gave up on it. Session files persist this name.
 */
export const REFUSED_TURN_MESSAGE_TYPE = "refused-turn";

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/**
 * Creates the marker that stands in for a refused reply a harness removed from
 * history. It carries nothing to the model; it tells
 * {@link filterProviderReplayMessages} where the refused step ended.
 */
export function createRefusedTurnMessage(timestamp: number): CustomMessage {
	return {
		role: "custom",
		customType: REFUSED_TURN_MESSAGE_TYPE,
		content: "",
		display: false,
		attribution: "agent",
		timestamp,
	};
}

function isRefusedTurnBoundary(message: AgentMessage): boolean {
	if (message.role === "assistant") return isProviderRefusalMessage(message);
	return message.role === "custom" && message.customType === REFUSED_TURN_MESSAGE_TYPE;
}

// Memoized per source result so repeated replays hand downstream identity
// caches the same message.
const withheldToolResults = new WeakMap<ToolResultMessage, ToolResultMessage>();

function withholdToolResult(message: ToolResultMessage): ToolResultMessage {
	let withheld = withheldToolResults.get(message);
	if (withheld === undefined) {
		withheld = {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: [{ type: "text", text: prompt.render(refusedToolResultPrompt) }],
			isError: message.isError,
			attribution: message.attribution,
			timestamp: message.timestamp,
		};
		withheldToolResults.set(message, withheld);
	}
	return withheld;
}

/**
 * Applies the live provider replay policy for refusals.
 *
 * Refused replies and refused-turn markers are never replayed, nor are the tool
 * results answering a refused reply's own calls. A refused step is everything
 * after the last accepted assistant reply. Once later input supersedes it (the
 * first message past the refusal and its own tool results is neither an
 * accepted reply nor another refusal), the step's input is left out as well:
 * its user, developer and custom messages are dropped, and its tool results
 * keep their call ids but carry a notice instead of their content. A refusal
 * then costs its own step instead of every later request. Compaction and branch
 * summaries are history, not input, and stay. A step nothing has superseded yet
 * keeps its input, so a retry still sends it; so does a step a later reply
 * answered.
 *
 * Returns `messages` itself when it holds no refusal.
 */
export function filterProviderReplayMessages<T extends AgentMessage>(messages: T[]): T[] {
	let hasRefusal = false;
	let refusedCallIds: Set<string> | undefined;
	for (const message of messages as AgentMessage[]) {
		if (!isRefusedTurnBoundary(message)) continue;
		hasRefusal = true;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") (refusedCallIds ??= new Set()).add(block.id);
		}
	}
	if (!hasRefusal) return messages;

	const isRefusedReply = (message: AgentMessage): boolean =>
		isRefusedTurnBoundary(message) ||
		(message.role === "toolResult" && refusedCallIds?.has(message.toolCallId) === true);

	// Per index: "drop", a withheld stand-in to send instead, or undefined to keep.
	const fates: Array<"drop" | T | undefined> = [];
	let stepStart = 0;
	for (let index = 0; index < messages.length; index++) {
		const message: AgentMessage = messages[index];
		if (message.role === "assistant" && !isProviderRefusalMessage(message)) {
			stepStart = index + 1;
			continue;
		}
		if (!isRefusedReply(message)) continue;
		fates[index] = "drop";
		if (!isRefusedTurnBoundary(message)) continue;
		let next = index + 1;
		while (next < messages.length && isRefusedReply(messages[next])) next++;
		if (next === messages.length || messages[next].role === "assistant") continue;
		for (let inputIndex = stepStart; inputIndex < index; inputIndex++) {
			const input: AgentMessage = messages[inputIndex];
			if (fates[inputIndex] !== undefined || input.role === "compactionSummary" || input.role === "branchSummary") {
				continue;
			}
			fates[inputIndex] = input.role === "toolResult" ? (withholdToolResult(input) as T) : "drop";
		}
		stepStart = index + 1;
	}

	const replayed: T[] = [];
	for (let index = 0; index < messages.length; index++) {
		const fate = fates[index];
		if (fate === "drop") continue;
		replayed.push(fate ?? messages[index]);
	}
	return replayed;
}
