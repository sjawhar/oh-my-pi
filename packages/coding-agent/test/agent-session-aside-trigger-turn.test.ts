import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An extension aside sent with `triggerTurn` that no running turn consumes still gets a turn,
 * also while an earlier user interrupt keeps auto-resume suppressed and in plan mode, unless a
 * user interrupt happened after it was sent. `agent_end` is tagged non-terminal only when a
 * stranded aside will start a turn.
 */
describe("AgentSession triggerTurn aside", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-aside-trigger-turn-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	interface Harness {
		session: AgentSession;
		mock: MockModel;
		modelRegistry: ModelRegistry;
		/** `isTerminal` of every `agent_end` the session published, in order. */
		agentEnds: Array<boolean | undefined>;
	}

	/** `onSessionStop` runs while the finished run still holds the session: after the loop's last aside poll, before it settles. */
	async function createHarness(onSessionStop?: () => Promise<void>): Promise<Harness> {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler: { content: ["Acknowledged."] } });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let extensionRunner: ExtensionRunner | undefined;
		if (onSessionStop) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_stop", async () => {
						await onSessionStop();
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"aside-at-session-stop",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});
		const agentEnds: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") agentEnds.push(event.isTerminal);
		});
		return { session, mock, modelRegistry, agentEnds };
	}

	function card(content: string) {
		return { customType: "ext-card", content, display: false, attribution: "agent" as const };
	}

	/** Waits until no run and no prompt setup or wake turn holds the session. */
	async function settle(target: AgentSession): Promise<void> {
		do {
			await target.waitForIdle();
			await setImmediate();
		} while (target.isStreaming);
	}

	function requestsContaining(mock: MockModel, text: string): number {
		return mock.calls.filter(call => JSON.stringify(call.context.messages).includes(text)).length;
	}

	function persisted(target: AgentSession, text: string): boolean {
		return target.agent.state.messages.some(message => message.role === "custom" && message.content === text);
	}

	interface HeldKeyLookup {
		/** Settles when the held lookup starts. */
		requested: Promise<void>;
		resolve(key: string | undefined): void;
		restore(): void;
	}

	/** Holds the next API-key lookup, which a direct prompt's setup makes before its run starts. */
	function holdNextKeyLookup(modelRegistry: ModelRegistry): HeldKeyLookup {
		const requested = Promise.withResolvers<void>();
		const key = Promise.withResolvers<string | undefined>();
		const spy = spyOn(modelRegistry, "getApiKey").mockImplementationOnce(async () => {
			requested.resolve();
			return key.promise;
		});
		return { requested: requested.promise, resolve: key.resolve, restore: () => spy.mockRestore() };
	}

	it("gets a turn when the prompt it was sent during is refused before its run", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		// An earlier Esc leaves auto-resume suppressed; a synthetic prompt does not clear it.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const keyLookup = holdNextKeyLookup(modelRegistry);
		try {
			const refused = session.prompt("SYNTHETIC_SETUP", { synthetic: true });
			await keyLookup.requested;
			expect(session.isStreaming).toBe(true);

			expect(
				await session.sendCustomMessage(card("CARD_DURING_SETUP"), { deliverAs: "aside", triggerTurn: true }),
			).toBe(false);
			keyLookup.resolve(undefined);
			await expect(refused).rejects.toThrow("No API key");
			await settle(session);
		} finally {
			keyLookup.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "CARD_DURING_SETUP")).toBe(1);
	});

	it("folds without a turn when an Esc lands in the same setup window", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const keyLookup = holdNextKeyLookup(modelRegistry);
		try {
			const dropped = session.prompt("SYNTHETIC_SETUP", { synthetic: true });
			await keyLookup.requested;
			await session.sendCustomMessage(card("CARD_BEFORE_ESC"), { deliverAs: "aside", triggerTurn: true });

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			keyLookup.resolve("openai-test-key");
			await dropped;
			await settle(session);
		} finally {
			keyLookup.restore();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_BEFORE_ESC")).toBe(true);
	});

	it("gets a turn when it lands after a run's last aside poll, and that run's agent_end says so", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_AFTER_POLL"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		// An extension turn runs with the earlier interrupt's suppression still in effect.
		expect(await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true })).toBe(true);
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_AFTER_POLL")).toBe(1);
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("CARD_AFTER_POLL");
		expect(agentEnds).toEqual([false, true]);
	});

	it("an aside without triggerTurn stranded after an interrupt folds, and that run's agent_end is terminal", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("PASSIVE_AFTER_POLL"), { deliverAs: "aside" });
		});
		const { session, mock, agentEnds } = harness;
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await settle(session);

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "PASSIVE_AFTER_POLL")).toBe(true);
		expect(agentEnds).toEqual([true]);
	});

	it("at idle after an earlier interrupt, triggerTurn decides between a turn and a fold", async () => {
		const { session, mock } = await createHarness();
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		expect(await session.sendCustomMessage(card("IDLE_PASSIVE"), { deliverAs: "aside" })).toBe(false);
		await settle(session);
		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "IDLE_PASSIVE")).toBe(true);

		expect(await session.sendCustomMessage(card("IDLE_TRIGGER"), { deliverAs: "aside", triggerTurn: true })).toBe(
			true,
		);
		await settle(session);
		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "IDLE_TRIGGER")).toBe(1);
	});

	it("in plan mode, triggerTurn starts a turn at idle like a steer does; without it the aside folds", async () => {
		const { session, mock } = await createHarness();
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		expect(await session.sendCustomMessage(card("PLAN_PASSIVE"), { deliverAs: "aside" })).toBe(false);
		await settle(session);
		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "PLAN_PASSIVE")).toBe(true);

		expect(await session.sendCustomMessage(card("PLAN_TRIGGER"), { deliverAs: "aside", triggerTurn: true })).toBe(
			true,
		);
		await settle(session);
		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "PLAN_TRIGGER")).toBe(1);
	});

	it("in plan mode, a triggerTurn aside stranded after a run's last aside poll gets a turn and a non-terminal agent_end", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("PLAN_AFTER_POLL"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("PLAN_AFTER_POLL");
		expect(agentEnds).toEqual([false, true]);
	});

	/** Strands a triggerTurn aside and then an aside without it after the extension turn's last aside poll. */
	async function expectStrandedAsidesInQueueOrder(setup: (target: AgentSession) => Promise<void>): Promise<void> {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("TRIGGER_FIRST"), { deliverAs: "aside", triggerTurn: true });
			await harness.session.sendCustomMessage(card("PASSIVE_SECOND"), { deliverAs: "aside" });
		});
		const { session, mock } = harness;
		await setup(session);

		await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		const request = JSON.stringify(mock.calls[1]!.context.messages);
		expect(request).toContain("PASSIVE_SECOND");
		expect(request.indexOf("TRIGGER_FIRST")).toBeGreaterThan(-1);
		expect(request.indexOf("TRIGGER_FIRST")).toBeLessThan(request.indexOf("PASSIVE_SECOND"));
		const persistedOrder = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message")
			.map(entry => entry.content);
		expect(persistedOrder).toEqual(["EXTENSION_TURN", "TRIGGER_FIRST", "PASSIVE_SECOND"]);
	}

	it("after an earlier interrupt, an aside without triggerTurn queued behind one with it rides that turn in queue order", async () => {
		await expectStrandedAsidesInQueueOrder(target => target.abort({ reason: USER_INTERRUPT_LABEL }));
	});

	it("in plan mode, an aside without triggerTurn queued behind one with it rides that turn in queue order", async () => {
		await expectStrandedAsidesInQueueOrder(async target => {
			target.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		});
	});

	it("folds without a turn when an Esc lands while its turn waits for a work-pool yield change", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_BEFORE_ESC"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock } = harness;
		// The stranded aside's turn joins a pending work-pool yield change before it starts: hold that change.
		const turnWaiting = Promise.withResolvers<void>();
		const yieldChange = Promise.withResolvers<void>();
		const yieldSpy = spyOn(session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			turnWaiting.resolve();
			return yieldChange.promise;
		});
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await turnWaiting.promise;

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			yieldChange.resolve();
			await extensionTurn;
			await setImmediate();
			await settle(session);
		} finally {
			yieldChange.resolve();
			yieldSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_BEFORE_ESC")).toBe(true);
	});

	it("in an ACP session, one that lands after the run it was sent during has ended waits for the client's next turn", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		// The aside's image normalization holds it until the switch below has changed the session generation.
		// Prompts normalize too, with no images: those pass straight through.
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		// The switch changes the session generation, then fails and restores it.
		const switchPaused = Promise.withResolvers<void>();
		const failSwitch = Promise.withResolvers<void>();
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			switchPaused.resolve();
			await failSwitch.promise;
			throw new Error("forced switch failure");
		});
		let keyLookup: HeldKeyLookup | undefined;
		try {
			const sent = session.sendCustomMessage(
				{
					customType: "ext-card",
					content: [
						{ type: "text", text: "LATE_CARD" },
						{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
					],
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
			await normalizeStarted.promise;
			const switched = session.switchSession(path.join(tempDir.path(), "target.jsonl"));
			await switchPaused.promise;
			// A client prompt's setup holds the session while the switch is paused.
			keyLookup = holdNextKeyLookup(modelRegistry);
			const refused = session.prompt("CLIENT_SETUP");
			await keyLookup.requested;
			expect(session.isStreaming).toBe(true);

			// The aside finds the session busy and waits out the generation change, past the prompt's end.
			releaseNormalize.resolve();
			await setImmediate();
			keyLookup.resolve(undefined);
			await expect(refused).rejects.toThrow("No API key");
			failSwitch.resolve();
			await expect(switched).rejects.toThrow("forced switch failure");
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			failSwitch.resolve();
			keyLookup?.resolve(undefined);
			keyLookup?.restore();
			setSessionFileSpy.mockRestore();
			normalizeSpy.mockRestore();
		}
		expect(mock.calls).toHaveLength(0);

		await session.prompt("CLIENT_TURN");
		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "LATE_CARD")).toBe(1);
	});
});
