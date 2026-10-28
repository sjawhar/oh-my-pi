/**
 * Durable record of the process-global pause gate in the session transcript.
 *
 * `/pause` lives in memory (`AgentPauseGate`), so without this marker nothing
 * outside the process can tell a session a human paused on purpose from one
 * that is merely idle: a pane watch cannot skip a paused session after a
 * reboot, and a tool that types `/pause` at a paused pane resumes it instead.
 *
 * One entry per gate transition: `paused` when it engages, `running` when it
 * releases. Both share one `customType`, so a reader greps the tail of the
 * JSONL for `"customType":"pause_state"` and takes the last hit.
 *
 * Reading the state, over the entries of one session file (a resumed session
 * appends to the same file, so every rule below is scoped to one run; both are
 * also documented for outside readers in `docs/session.md`):
 * - **Now** (process alive, {@link pauseStateFromEntries}): the last
 *   `pause_state` entry *after* the last `session_exit` entry. None means this
 *   run recorded no pause.
 * - **When a process died** ({@link pauseStateAtExit}): the last `pause_state` entry *between* the last
 *   two `session_exit` entries — that run's own segment. Searching the whole
 *   prefix instead would report an older run's pause as this one's.
 *   `state: "paused"` means the session held a deliberate pause when it went
 *   away, so a restart must not run it blind. A `SIGKILL` or a panic writes no
 *   `session_exit` at all, so a transcript whose tail is `paused` is either a
 *   live pause or a process killed during one; only a liveness check (the pid
 *   or the pane) tells those apart.
 *
 * `AgentSession` subscribes for every mode it backs — TUI, print, ACP, RPC and
 * an SDK embedder — so the record follows the gate rather than a front end.
 * Absence is still not evidence of running: a session held only in memory
 * writes no file, and a host that drives `agentLoop` without an `AgentSession`
 * records nothing.
 *
 * A restart never re-engages the gate: a session that comes back up is
 * running, and writes its own entries from there. {@link reconcilePauseStateOnLoad}
 * appends that `running` entry when the loaded tail says `paused`, so the
 * "now" rule stays true for a session resumed after it was killed mid-pause.
 */
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { SESSION_EXIT_CUSTOM_TYPE } from "./exit-diagnostics";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** `customType` of the pause/resume markers in the session JSONL. */
export const PAUSE_STATE_CUSTOM_TYPE = "pause_state";

/** Payload of a {@link PAUSE_STATE_CUSTOM_TYPE} custom entry. */
export interface PauseStateData {
	/** `paused` while the gate is engaged, `running` once it is released. */
	state: "paused" | "running";
	/** Epoch ms of the transition. */
	at: number;
	/** How long the pause held, in ms. Only on a `running` entry. */
	heldMs?: number;
}

/** The slice of {@link SessionManager} the marker needs. */
export type PauseStateRecorder = Pick<SessionManager, "appendCustomEntry" | "flushSync" | "getEntries">;

function append(manager: PauseStateRecorder, data: PauseStateData): void {
	try {
		manager.appendCustomEntry(PAUSE_STATE_CUSTOM_TYPE, data);
	} catch (error) {
		logger.warn("pause state not recorded", { state: data.state, error: String(error) });
		return;
	}
	try {
		// Synchronous: the reader of this marker is a tool looking at a session
		// whose process is already gone, including one killed without warning.
		manager.flushSync();
	} catch (error) {
		// The entry is in the transcript already; only the immediate flush
		// failed (an open atomic batch refuses one).
		// It lands with the next write; a kill inside that window loses it.
		logger.debug("pause state not flushed immediately", { state: data.state, error: String(error) });
	}
}

/**
 * Append a pause/resume marker. Synchronous: the entry is in the transcript
 * when this returns, and on disk whenever the session has a file.
 *
 * Persistence is lazy, so a session nobody has prompted yet has no file; the
 * entry is held in memory and written when the session materializes. Such a
 * session has no transcript to restart either, so nothing is lost by not
 * forcing a file into existence for it.
 */
export function writePauseState(manager: PauseStateRecorder, state: PauseStateData["state"], heldMs?: number): void {
	append(manager, { state, at: Date.now(), ...(heldMs === undefined ? {} : { heldMs }) });
}

/**
 * Record every transition of the process-global pause gate into the session
 * `getManager()` names at the time of the transition. Returns an unsubscribe.
 *
 * Subscribing to the gate rather than writing from the `/pause` screen is what
 * makes the transcript trustworthy: the gate is exported API
 * (`@oh-my-pi/pi-agent-core`), so a plugin or an SDK embedder in this process
 * can pause or resume it too, and a marker written only by the screen would
 * miss that and leave the transcript asserting the opposite of the truth.
 *
 * Because the session is resolved per transition, a driver that switches
 * sessions while the gate is engaged leaves the first transcript ending on
 * `paused` and writes `running` to the second; opening the first one heals it
 * ({@link reconcilePauseStateOnLoad}). The `/pause` screen cannot reach that:
 * it owns input focus for the whole pause, so no command or switch runs.
 */
export function recordPauseStateTransitions(getManager: () => PauseStateRecorder | undefined): () => void {
	let pausedAt: number | undefined;
	return agentPauseGate.onChange(paused => {
		const heldMs = paused || pausedAt === undefined ? undefined : Date.now() - pausedAt;
		pausedAt = paused ? Date.now() : undefined;
		const manager = getManager();
		if (manager) writePauseState(manager, paused ? "paused" : "running", heldMs);
	});
}

/**
 * The pause state the transcript asserts for the current run: the last
 * `pause_state` entry after the last `session_exit`, or `undefined` when this
 * run recorded none.
 */
export function pauseStateFromEntries(entries: readonly SessionEntry[]): PauseStateData["state"] | undefined {
	return scanBack(entries, entries.length - 1);
}

/**
 * The pause state the run that just ended held when its process died: the last
 * `pause_state` entry between the last two `session_exit` entries, or
 * `undefined` when that run recorded none.
 *
 * A resumed session appends to the same file, so the segment matters: searching
 * the whole prefix would report an older run's pause as this one's.
 */
export function pauseStateAtExit(entries: readonly SessionEntry[]): PauseStateData["state"] | undefined {
	const exit = entries.findLastIndex(
		entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE,
	);
	if (exit === -1) return undefined;
	return scanBack(entries, exit - 1);
}

/** The last `pause_state` at or before `from`, stopping at a `session_exit`. */
function scanBack(entries: readonly SessionEntry[], from: number): PauseStateData["state"] | undefined {
	for (let index = from; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom") continue;
		if (entry.customType === SESSION_EXIT_CUSTOM_TYPE) return undefined;
		if (entry.customType !== PAUSE_STATE_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || !("state" in data)) return undefined;
		return data.state === "paused" ? "paused" : "running";
	}
	return undefined;
}

/**
 * Restore the "last marker wins" invariant for a session being opened.
 *
 * A process killed mid-pause (SIGKILL, OOM, a reboot) writes no `session_exit`,
 * so its transcript ends on `paused`. The gate is memory-only and this process
 * comes up running, so without this entry every reader would keep calling a
 * live session paused. Call it wherever a session is loaded or switched into.
 */
export function reconcilePauseStateOnLoad(manager: PauseStateRecorder): void {
	// A gate engaged right now makes the tail true, not stale: a driver that
	// switches sessions under a live pause must not be told it may prompt.
	if (agentPauseGate.paused) return;
	if (pauseStateFromEntries(manager.getEntries()) !== "paused") return;
	writePauseState(manager, "running");
}
