import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
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

	/**
	 * `onSessionStop` runs while the finished run still holds the session: after the loop's last aside poll, before it settles.
	 * `responses` answer the first model requests; later ones answer "Acknowledged.".
	 */
	async function createHarness(onSessionStop?: () => Promise<void>, responses?: MockResponse[]): Promise<Harness> {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses,
			handler: { content: ["Acknowledged."] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.enabled": false,
		});
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

	// Composition note (release commit only): the background-job wake member (#17243) makes an
	// interrupt that stopped no run suppress nothing, so the two cases below — both of which
	// interrupt an idle session — now wake instead of folding. The fold these tests were written
	// for still holds for an interrupt that stopped a run; that is what the suppression tests in
	// agent-session-advisor-suppression.test.ts cover.
	it("an aside without triggerTurn stranded after an interrupt that stopped nothing wakes a turn", async () => {
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

		expect(mock.calls).toHaveLength(2);
		expect(persisted(session, "PASSIVE_AFTER_POLL")).toBe(true);
		expect(requestsContaining(mock, "PASSIVE_AFTER_POLL")).toBe(1);
		expect(agentEnds).toEqual([false, true]);
	});

	it("at idle after an interrupt that stopped nothing, an aside wakes with or without triggerTurn", async () => {
		const { session, mock } = await createHarness();
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		expect(await session.sendCustomMessage(card("IDLE_PASSIVE"), { deliverAs: "aside" })).toBe(true);
		await settle(session);
		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "IDLE_PASSIVE")).toBe(true);

		expect(await session.sendCustomMessage(card("IDLE_TRIGGER"), { deliverAs: "aside", triggerTurn: true })).toBe(
			true,
		);
		await settle(session);
		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "IDLE_TRIGGER")).toBe(1);
	});

	// Composition test (release commit only, R-rc4-3/R-rc4-6): the suppression latch means the
	// same thing on every delivery path. After an interrupt that did stop a run, a passive aside
	// folds; once a later turn has run and ended on its own, the stopped run is over and the next
	// one wakes, exactly as a background job result does in the yield queue.
	it("after an interrupt that stopped a run, a passive aside folds until a later turn has ended", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		const keyLookup = holdNextKeyLookup(modelRegistry);
		try {
			const dropped = session.prompt("SETUP_RUN", { synthetic: true });
			await keyLookup.requested;
			expect(session.isStreaming).toBe(true);
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			keyLookup.resolve("openai-test-key");
			await dropped;
			await settle(session);
		} finally {
			keyLookup.restore();
		}
		expect(mock.calls).toHaveLength(0);

		// The stopped run is still the last thing that happened.
		expect(await session.sendCustomMessage(card("AFTER_STOP"), { deliverAs: "aside" })).toBe(false);
		await settle(session);
		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "AFTER_STOP")).toBe(true);

		// A triggerTurn aside is promised its turn even while suppressed; it ends on its own.
		expect(await session.sendCustomMessage(card("WAKE_TURN"), { deliverAs: "aside", triggerTurn: true })).toBe(true);
		await settle(session);
		expect(mock.calls).toHaveLength(1);

		// Same latch, now read with a settled turn behind it: the passive aside wakes.
		expect(await session.sendCustomMessage(card("AFTER_SETTLE"), { deliverAs: "aside" })).toBe(true);
		await settle(session);
		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "AFTER_SETTLE")).toBe(1);
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

	interface HeldWorkPoolYieldWait {
		/** Settles when a wake turn starts to wait for the work-pool yield change. */
		reached: Promise<void>;
		release(): void;
		restore(): void;
	}

	/** Holds every wake turn in its work-pool yield wait, the window before it starts the turn. */
	function holdWorkPoolYieldWait(target: AgentSession): HeldWorkPoolYieldWait {
		const reached = Promise.withResolvers<void>();
		const change = Promise.withResolvers<void>();
		const spy = spyOn(target, "whenWorkPoolYieldSettled").mockImplementation(() => {
			reached.resolve();
			return change.promise;
		});
		return {
			reached: reached.promise,
			release: () => change.resolve(),
			restore: () => spy.mockRestore(),
		};
	}

	/** A card whose image normalization a test can hold, to outlast the run it was sent from. */
	function imageCard(content: string) {
		return {
			customType: "ext-card",
			content: [
				{ type: "text" as const, text: content },
				{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			display: false,
			attribution: "agent" as const,
		};
	}

	it("is dropped when a new session starts while its turn waits for a work-pool yield change", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_BEFORE_NEW"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock } = harness;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;

			// The new session clears the IRC queues and the transcript the aside belonged to.
			await session.newSession();
			yieldWait.release();
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_BEFORE_NEW")).toBe(false);
	});

	it("keeps its run's agent_end open while image normalization outlasts the run", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			// The extension API returns void: the send is not awaited, and its normalization runs on.
			void harness.session.sendCustomMessage(imageCard("CARD_SLOW_IMAGE"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		try {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await normalizeStarted.promise;
			await settle(session);

			// The turn the aside asked for is still being prepared, so that run did not end the work.
			expect(mock.calls).toHaveLength(1);
			expect(agentEnds).toEqual([false]);

			releaseNormalize.resolve();
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_SLOW_IMAGE")).toBe(1);
		expect(agentEnds).toEqual([false, true]);
	});

	it("folds when an Esc lands while its idle turn waits for the usage preflight", async () => {
		const { session, mock } = await createHarness();
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const preflightReached = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		const preflightSpy = spyOn(TurnRecovery.prototype, "maybeApplyUsageAwareFallback").mockImplementation(
			async () => {
				preflightReached.resolve();
				await releasePreflight.promise;
				return false;
			},
		);
		try {
			const sent = session.sendCustomMessage(card("CARD_IN_PREFLIGHT"), { deliverAs: "aside", triggerTurn: true });
			await preflightReached.promise;

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			releasePreflight.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releasePreflight.resolve();
			preflightSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_IN_PREFLIGHT")).toBe(true);
	});

	it("of two sent at once to an idle session after an interrupt, the queued one gets a turn when the first run ends before its aside poll", async () => {
		// The first run fails, so its loop ends without the stop-boundary aside poll that would take the queued aside.
		const { session, mock } = await createHarness(undefined, [
			{ stopReason: "error", errorMessage: "400 bad request" },
		]);
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		await Promise.all([
			session.sendCustomMessage(card("FIRST_CARD"), { deliverAs: "aside", triggerTurn: true }),
			session.sendCustomMessage(card("SECOND_CARD"), { deliverAs: "aside", triggerTurn: true }),
		]);
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "FIRST_CARD")).toBeGreaterThan(0);
		expect(requestsContaining(mock, "SECOND_CARD")).toBeGreaterThan(0);
	});

	it("stays parked for a monitored wake when a rolled-back transition and a pooled contract catch its turn in the work-pool wait", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_POOLED"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		const switchPaused = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		session.setSessionBeforeSwitchReconciler(async () => {
			switchPaused.resolve();
			await releaseSwitch.promise;
		});
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			throw new Error("forced switch failure");
		});
		let switched: Promise<boolean> | undefined;
		try {
			// The extension turn strands the aside, and its wake enters the work-pool wait.
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;

			// A pooled turn takes the worker, and a switch disconnects the agent before its own reset.
			void session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			switched = session.switchSession(path.join(tempDir.path(), "target.jsonl"));
			await switchPaused.promise;

			yieldWait.release();
			await setImmediate();
			releaseSwitch.resolve();
			await expect(switched).rejects.toThrow("forced switch failure");
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			releaseSwitch.resolve();
			yieldWait.restore();
			setSessionFileSpy.mockRestore();
			session.setSessionBeforeSwitchReconciler(null);
			await switched?.catch(() => {});
		}

		// The record waits for a wake of its own: a pooled turn must not flush it into its batch.
		expect(session.ircWakesPending).toBe(true);
		await session.prompt("POOLED_TURN");
		await settle(session);
		expect(requestsContaining(mock, "CARD_POOLED")).toBe(0);

		// Clearing the contract gives it that wake.
		await session.setWorkPoolYieldItems([]);
		await settle(session);
		expect(requestsContaining(mock, "CARD_POOLED")).toBe(1);
	});

	it("gets its turn as soon as a rolled-back switch restores the queue it was parked in", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_ROLLED_BACK"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		const switchPaused = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		session.setSessionBeforeSwitchReconciler(async () => {
			switchPaused.resolve();
			await releaseSwitch.promise;
		});
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			throw new Error("forced switch failure");
		});
		let switched: Promise<boolean> | undefined;
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;

			// The switch has disconnected the agent and has not yet snapshotted the queues.
			switched = session.switchSession(path.join(tempDir.path(), "target.jsonl"));
			await switchPaused.promise;

			yieldWait.release();
			await setImmediate();
			releaseSwitch.resolve();
			await expect(switched).rejects.toThrow("forced switch failure");
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			releaseSwitch.resolve();
			yieldWait.restore();
			setSessionFileSpy.mockRestore();
			session.setSessionBeforeSwitchReconciler(null);
			await switched?.catch(() => {});
		}

		// The rollback restored the record into the live session: it gets its turn with no
		// further prompt from anyone.
		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_ROLLED_BACK")).toBe(1);
	});

	it("holds no agent_end of the session that replaced its own open", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const { session, mock, agentEnds } = await createHarness();
		try {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			const sent = session.sendCustomMessage(imageCard("CARD_OLD_SESSION"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await normalizeStarted.promise;

			// The send belongs to the transcript this replaces.
			expect(await session.newSession()).toBe(true);
			await session.prompt("NEW_SESSION_TURN");
			await settle(session);

			// That turn ended the work of the new session: nothing of the old send follows it.
			expect(agentEnds).toEqual([true]);

			releaseNormalize.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "CARD_OLD_SESSION")).toBe(0);
	});

	it("keeps the agent_end of the session it lands in open when a new session starts during startup extension loading", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const { session, mock, agentEnds } = await createHarness();
		const loadStarted = Promise.withResolvers<void>();
		const releaseLoad = Promise.withResolvers<void>();
		session.setDeferredExtensionLoader(async () => {
			loadStarted.resolve();
			await releaseLoad.promise;
		});
		try {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			const sent = session.sendCustomMessage(imageCard("CARD_AFTER_LOAD"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await loadStarted.promise;

			// The send is still waiting for the extensions when the new session commits; it goes on
			// into the new session once they load.
			expect(await session.newSession()).toBe(true);
			releaseLoad.resolve();
			await normalizeStarted.promise;
			await session.prompt("NEW_SESSION_TURN");
			await settle(session);

			// The aside's turn in this session is still being prepared, so that run did not end the work.
			expect(agentEnds).toEqual([false]);

			releaseNormalize.resolve();
			await sent;
			await settle(session);
		} finally {
			releaseLoad.resolve();
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_AFTER_LOAD")).toBe(1);
		expect(agentEnds).toEqual([false, true]);
	});
});
