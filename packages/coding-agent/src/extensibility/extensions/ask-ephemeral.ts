import { prompt } from "@oh-my-pi/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { AskEphemeralHandler } from "./types";

/** Builds the extension action that runs an isolated /btw-compatible side turn. */
export function createAskEphemeralHandler(session: AgentSession): AskEphemeralHandler {
	return async ({ prompt: question, signal }) => {
		const { replyText } = await session.runEphemeralTurn({
			promptText: prompt.render(btwUserPrompt, { question }),
			signal,
		});
		return { replyText };
	};
}
