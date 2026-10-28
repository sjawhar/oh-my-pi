import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SESSION_EXIT_CUSTOM_TYPE } from "../src/session/exit-diagnostics";
import {
	PAUSE_STATE_CUSTOM_TYPE,
	type PauseStateData,
	pauseStateAtExit,
	pauseStateFromEntries,
	recordPauseStateTransitions,
	reconcilePauseStateOnLoad,
	writePauseState,
} from "../src/session/pause-state";
import type { SessionEntry } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";

interface CustomLine {
	type?: string;
	customType?: string;
	data?: unknown;
}

const temps: TempDir[] = [];

function manager(): SessionManager {
	const dir = TempDir.createSync("@omp-pause-state-");
	temps.push(dir);
	return SessionManager.create(dir.path(), dir.path());
}

function readCustomEntries(file: string): CustomLine[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as CustomLine)
		.filter(entry => entry.type === "custom");
}

function markerState(entry: CustomLine | undefined): "paused" | "running" | "never-paused" {
	const data = entry?.data;
	if (typeof data !== "object" || data === null || !("state" in data)) return "never-paused";
	return data.state === "paused" ? "paused" : "running";
}

/**
 * What a tool outside the process reads from the bytes on disk: the file is
 * parsed back into entries and handed to the shipped reader, so this test
 * cannot drift from the rule the product implements.
 */
function pauseStateOnDiskAtExit(file: string): "paused" | "running" | undefined {
	const entries = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as SessionEntry);
	return pauseStateAtExit(entries);
}

describe("pause state marker", () => {
	afterEach(() => {
		agentPauseGate.resume();
		for (const dir of temps.splice(0)) dir[Symbol.dispose]();
	});

	it("appends a paused entry and then a running entry with the hold time", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		writePauseState(session, "paused");
		writePauseState(session, "running", 6 * 60 * 60 * 1000);

		const markers = readCustomEntries(file)
			.filter(entry => entry.customType === PAUSE_STATE_CUSTOM_TYPE)
			.map(entry => entry.data as PauseStateData);
		expect(markers.map(marker => marker.state)).toEqual(["paused", "running"]);
		expect(markers[0].at).toBeGreaterThan(0);
		expect(markers[0].heldMs).toBeUndefined();
		expect(markers[1].heldMs).toBe(6 * 60 * 60 * 1000);
	});

	// A reader of the JSONL alone must be able to tell that the session was
	// paused when its process ended.
	it("reads as paused when the process exits during a pause", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		writePauseState(session, "paused");
		session.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "sigterm",
			kind: "signal",
			recordedAt: new Date().toISOString(),
		});
		session.flushSync();

		expect(pauseStateOnDiskAtExit(file)).toBe("paused");
	});

	// A2: the same reader must see a resumed session as running.
	it("reads as running when the pause was released before the exit", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		writePauseState(session, "paused");
		writePauseState(session, "running", 9_000);
		session.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "sigterm",
			kind: "signal",
			recordedAt: new Date().toISOString(),
		});
		session.flushSync();

		expect(pauseStateOnDiskAtExit(file)).toBe("running");
	});

	// Persistence is lazy: a session nobody has prompted has no file, and the
	// marker must neither force one into existence nor be lost.
	it("keeps the marker for a session with no file yet and writes it on materialize", async () => {
		const session = manager();
		expect(session.isSessionOnDisk()).toBe(false);

		writePauseState(session, "paused");
		expect(session.isSessionOnDisk()).toBe(false);

		session.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		expect(pauseStateFromEntries(session.getEntries())).toBe("paused");
		expect(readCustomEntries(file).some(entry => entry.customType === PAUSE_STATE_CUSTOM_TYPE)).toBe(true);
	});

	// A resumed session appends to the same file: the pause of an earlier run
	// must not be read as the state of the run that just ended.
	it("does not carry an earlier run's pause into the next run's exit", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		writePauseState(session, "paused");
		session.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, { reason: "sigterm", kind: "signal" });
		// Second run: resumed, never paused, exits cleanly.
		session.appendMessage({ role: "user", content: "second run", timestamp: Date.now() });
		session.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, { reason: "exit", kind: "normal" });
		session.flushSync();

		expect(pauseStateOnDiskAtExit(file)).toBeUndefined();
	});

	it("reports the live state from the entries after the last exit", () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		expect(pauseStateFromEntries(session.getEntries())).toBeUndefined();

		session.appendCustomEntry(PAUSE_STATE_CUSTOM_TYPE, { state: "paused", at: Date.now() });
		expect(pauseStateFromEntries(session.getEntries())).toBe("paused");

		session.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, { reason: "sigterm", kind: "signal" });
		expect(pauseStateFromEntries(session.getEntries())).toBeUndefined();
	});

	// A SIGKILL mid-pause writes no session_exit, so the transcript ends on
	// `paused`. Reopening the session must not leave that lie in place.
	it("records running when a session is opened on a transcript killed mid-pause", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		writePauseState(session, "paused");

		reconcilePauseStateOnLoad(session);

		expect(pauseStateFromEntries(session.getEntries())).toBe("running");
		const states = readCustomEntries(file)
			.filter(entry => entry.customType === PAUSE_STATE_CUSTOM_TYPE)
			.map(entry => markerState(entry));
		expect(states).toEqual(["paused", "running"]);
	});

	it("writes nothing when the loaded transcript is not paused", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		writePauseState(session, "paused");
		writePauseState(session, "running", 5);
		const before = session.getEntries().length;

		reconcilePauseStateOnLoad(session);

		expect(session.getEntries().length).toBe(before);
	});

	// The one direction in which this marker lying is harmful: a reader that
	// concludes it may prompt a session that is in fact frozen.
	it("leaves a paused tail alone when the gate is engaged right now", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		writePauseState(session, "paused");
		const before = session.getEntries().length;

		agentPauseGate.pause();
		reconcilePauseStateOnLoad(session);

		expect(session.getEntries().length).toBe(before);
		expect(pauseStateFromEntries(session.getEntries())).toBe("paused");
	});

	// The marker follows the gate, not the `/pause` screen: the gate is exported
	// API, so a plugin or the SDK can drive it in the same process.
	it("records every gate transition while subscribed, and none after", async () => {
		const session = manager();
		session.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		const unsubscribe = recordPauseStateTransitions(() => session);
		try {
			agentPauseGate.pause();
			expect(pauseStateFromEntries(session.getEntries())).toBe("paused");
			agentPauseGate.resume();
			expect(pauseStateFromEntries(session.getEntries())).toBe("running");
		} finally {
			unsubscribe();
		}
		agentPauseGate.pause();
		agentPauseGate.resume();

		const markers = readCustomEntries(file).filter(entry => entry.customType === PAUSE_STATE_CUSTOM_TYPE);
		expect(markers.map(entry => markerState(entry))).toEqual(["paused", "running"]);
		expect((markers[1].data as PauseStateData).heldMs).toBeGreaterThanOrEqual(0);
	});
});
