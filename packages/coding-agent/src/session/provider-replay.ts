import { type AgentMessage, filterProviderReplayMessages } from "@oh-my-pi/pi-agent-core";
import { CONTEXT_NOTES_ENTRY_TYPE } from "./context-notes";

/**
 * The session's provider replay policy. A refused step's input is left out only
 * at the refused-turn marker the session leaves once recovery gives up: a
 * refusal still in history may be one a fallback retry is answering, so it
 * keeps its input. Context notes are session memory, kept like summaries.
 *
 * Runs on unconverted messages: conversion drops the marker it keys on.
 */
export function filterSessionReplayMessages(messages: AgentMessage[]): AgentMessage[] {
	return filterProviderReplayMessages(messages, {
		stripOnlyAtMarkers: true,
		isHistory: message => message.role === "custom" && message.customType === CONTEXT_NOTES_ENTRY_TYPE,
	});
}
