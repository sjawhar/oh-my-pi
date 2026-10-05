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

function isRefusedTurnMarker(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === REFUSED_TURN_MESSAGE_TYPE;
}

/** An assistant reply that completed: neither errored (refusals included) nor aborted. */
function isAcceptedReply(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted";
}

/** Options for {@link filterProviderReplayMessages}. */
export interface ProviderReplayOptions {
	/**
	 * Strip a refused step's input only at a refused-turn marker. A harness that
	 * retries refusals sets this: a refusal still in history means recovery may
	 * be retrying the step, so only the refusal and its own tool results drop.
	 */
	stripOnlyAtMarkers?: boolean;
	/** Further messages that are history, not step input, kept like summaries. */
	isHistory?: (message: AgentMessage) => boolean;
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
 * Applies the live provider replay policy for refusals. It takes unconverted
 * `AgentMessage`s and must run before conversion: conversion drops the
 * refused-turn marker it keys on.
 *
 * Refused replies and refused-turn markers are never replayed, nor are the tool
 * results answering a refused reply's own calls. A refused step is everything
 * after the last accepted assistant reply (one that neither errored nor was
 * aborted). Once later input supersedes it (the first message past the
 * boundary, skipping other refusals and errored or aborted replies with their
 * tool results, is not an accepted reply), the step's input is left out as
 * well: tool results of accepted calls keep their call ids but carry a notice
 * instead of their content, and every other message is dropped (user,
 * developer, custom and hook messages, file mentions, shell execution output,
 * and errored or aborted replies with their tool results). A refusal then costs
 * its own step instead of every later request. Compaction and branch summaries,
 * and anything `options.isHistory` names, are history, not input, and stay. A
 * step nothing has superseded yet keeps its input, so a retry still sends it;
 * so does a step a later reply answered.
 *
 * Returns `messages` itself when it holds no refusal.
 */
export function filterProviderReplayMessages<T extends AgentMessage>(
	messages: readonly T[],
	options: ProviderReplayOptions = {},
): T[] {
	const history: readonly AgentMessage[] = messages;
	let hasRefusal = false;
	const refusedCallIds = new Set<string>();
	const failedCallIds = new Set<string>();
	for (const message of history) {
		if (isRefusedTurnMarker(message)) hasRefusal = true;
		if (message.role !== "assistant" || isAcceptedReply(message)) continue;
		const refusal = isProviderRefusalMessage(message);
		if (refusal) hasRefusal = true;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			failedCallIds.add(block.id);
			if (refusal) refusedCallIds.add(block.id);
		}
	}
	// Identity on purpose: callers' conversion caches key on the array.
	if (!hasRefusal) return messages as T[];

	const isRefusalReply = (message: AgentMessage): boolean =>
		message.role === "assistant" && isProviderRefusalMessage(message);
	// Never replayed: refusals, markers and the refusals' own tool results.
	const isRefusedReply = (message: AgentMessage): boolean =>
		isRefusedTurnMarker(message) ||
		isRefusalReply(message) ||
		(message.role === "toolResult" && refusedCallIds.has(message.toolCallId));
	// Not an answer: a marker, any failed reply, and its tool results.
	const isFailedReply = (message: AgentMessage): boolean =>
		isRefusedTurnMarker(message) ||
		(message.role === "assistant" && !isAcceptedReply(message)) ||
		(message.role === "toolResult" && failedCallIds.has(message.toolCallId));

	// Per index: "drop", a withheld stand-in to send instead, or undefined to keep.
	const fates: Array<"drop" | T | undefined> = [];
	let stepStart = 0;
	for (let index = 0; index < history.length; index++) {
		const message = history[index];
		if (isAcceptedReply(message)) {
			stepStart = index + 1;
			continue;
		}
		if (isRefusedReply(message)) fates[index] = "drop";
		const boundary = isRefusedTurnMarker(message) || (!options.stripOnlyAtMarkers && isRefusalReply(message));
		if (!boundary) continue;
		let next = index + 1;
		while (next < history.length && isFailedReply(history[next])) next++;
		if (next === history.length || isAcceptedReply(history[next])) continue;
		for (let inputIndex = stepStart; inputIndex < next; inputIndex++) {
			const input = history[inputIndex];
			if (fates[inputIndex] !== undefined) continue;
			if (input.role === "compactionSummary" || input.role === "branchSummary" || options.isHistory?.(input)) {
				continue;
			}
			fates[inputIndex] =
				input.role === "toolResult" && !failedCallIds.has(input.toolCallId)
					? (withholdToolResult(input) as T)
					: "drop";
		}
		stepStart = next;
	}

	const replayed: T[] = [];
	for (let index = 0; index < messages.length; index++) {
		const fate = fates[index];
		if (fate === "drop") continue;
		replayed.push(fate ?? messages[index]);
	}
	return replayed;
}
