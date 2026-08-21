import { afterAll, describe, expect, it } from "bun:test";
import { FakeWebSocket, fake } from "./chrome-fake";
import "../extension/background";

type OutboundMessage = Record<string, unknown>;

async function flush(rounds = 12): Promise<void> {
	for (let index = 0; index < rounds; index++) await Promise.resolve();
}

async function relaySocket(): Promise<FakeWebSocket> {
	for (let index = 0; index < 12; index++) {
		const socket = FakeWebSocket.instances[0];
		if (socket) return socket;
		await Promise.resolve();
	}
	throw new Error("background worker did not create a WebSocket");
}

function messages(socket: FakeWebSocket): OutboundMessage[] {
	return socket.sent.map(message => JSON.parse(message) as OutboundMessage);
}

function messagesOfType(socket: FakeWebSocket, type: string): OutboundMessage[] {
	return messages(socket).filter(message => message.t === type);
}

async function prepareScope(tabs: ChromeTab[], groups: ChromeTabGroup[]): Promise<FakeWebSocket> {
	fake.reset();
	fake.tabs.push(...tabs);
	fake.groups.push(...groups);
	const socket = await relaySocket();
	socket.open();
	await flush();
	socket.receive(JSON.stringify({ t: "config", allTabs: false }));
	await flush();
	return socket;
}

const ompGroup: ChromeTabGroup = { id: 5, windowId: 1, title: "omp", color: "cyan" };
const scopedTab: ChromeTab = {
	id: 1,
	url: "https://example.com/",
	title: "Example",
	active: false,
	windowId: 1,
	pinned: false,
	groupId: 5,
};

afterAll(() => {
	for (const socket of FakeWebSocket.instances) socket.close();
});

describe("browser relay extension scope enforcement", () => {
	it("tombstones a tab before a pending membership lookup can leak an event or send command", async () => {
		const socket = await prepareScope([{ ...scopedTab }], [{ ...ompGroup }]);
		expect(messagesOfType(socket, "hello")).toContainEqual(
			expect.objectContaining({ t: "hello", tabs: [expect.objectContaining({ tabId: 1 })] }),
		);

		const gate = fake.holdNextGroupQuery();
		const tab = fake.tabs[0]!;
		tab.groupId = -1;
		fake.events.tabs.onUpdated.emit(1, { groupId: -1 }, tab);
		await flush(4);
		const messagesBeforeRace = messages(socket).length;

		fake.events.debugger.onEvent.emit({ tabId: 1 }, "Page.loadEventFired", {});
		expect(messages(socket).slice(messagesBeforeRace)).not.toContainEqual(expect.objectContaining({ t: "cdpEvent" }));

		socket.receive(JSON.stringify({ t: "rpc", id: 7, op: "send", tabId: 1, method: "Runtime.evaluate" }));
		await flush(4);
		expect(fake.calls.debugger.sendCommand).toHaveLength(0);
		expect(messages(socket)).not.toContainEqual(expect.objectContaining({ t: "rpcResult", id: 7 }));

		gate.release([]);
		await flush(32);
		expect(fake.calls.debugger.detach).toContainEqual({ tabId: 1 });
		expect(messages(socket)).toContainEqual(expect.objectContaining({ t: "tabRemoved", tabId: 1 }));
		expect(messages(socket)).toContainEqual(
			expect.objectContaining({
				t: "rpcResult",
				id: 7,
				ok: false,
				error: "tab 1 is not in the omp tab group",
			}),
		);
		expect(fake.calls.debugger.sendCommand).toHaveLength(0);
	});

	it("revokes captured tabs when a group reconciliation cannot determine membership", async () => {
		const socket = await prepareScope([{ ...scopedTab }], [{ ...ompGroup }]);
		fake.failNextTabsQuery(new Error("boom"));
		fake.events.tabGroups.onUpdated.emit({ ...ompGroup });
		await flush();

		expect(fake.calls.debugger.detach).toContainEqual({ tabId: 1 });
		expect(messages(socket)).toContainEqual(expect.objectContaining({ t: "tabRemoved", tabId: 1 }));
		const messagesBeforeEvent = messages(socket).length;
		fake.events.debugger.onEvent.emit({ tabId: 1 }, "Page.loadEventFired", {});
		expect(messages(socket).slice(messagesBeforeEvent)).not.toContainEqual(
			expect.objectContaining({ t: "cdpEvent" }),
		);
	});

	it("rejects attach for an ungrouped tab before invoking chrome.debugger.attach", async () => {
		const socket = await prepareScope([{ ...scopedTab, groupId: -1 }], []);
		socket.receive(JSON.stringify({ t: "rpc", id: 8, op: "attach", tabId: 1 }));
		await flush();

		expect(fake.calls.debugger.attach).toHaveLength(0);
		expect(messages(socket)).toContainEqual(
			expect.objectContaining({
				t: "rpcResult",
				id: 8,
				ok: false,
				error: "tab 1 is not in the omp tab group",
			}),
		);
	});

	it("removes a new tab when joining the omp group fails", async () => {
		const socket = await prepareScope([], []);
		fake.failNextTabsGroup(new Error("grouping failed"));
		socket.receive(JSON.stringify({ t: "rpc", id: 9, op: "createTab", url: "https://example.com/new" }));
		await flush();

		expect(fake.calls.tabs.remove).toEqual([100]);
		expect(messages(socket)).toContainEqual(
			expect.objectContaining({
				t: "rpcResult",
				id: 9,
				ok: false,
				error: "created tab could not join the omp tab group",
			}),
		);
	});

	it("does not treat a pattern-matched non-omp group as scoped", async () => {
		const socket = await prepareScope([{ ...scopedTab }], [{ ...ompGroup, title: "omp-not-the-acl" }]);
		expect(messagesOfType(socket, "hello")).toContainEqual(expect.objectContaining({ t: "hello", tabs: [] }));

		socket.receive(JSON.stringify({ t: "rpc", id: 10, op: "attach", tabId: 1 }));
		await flush();
		expect(fake.calls.debugger.attach).toHaveLength(0);
		expect(messages(socket)).toContainEqual(
			expect.objectContaining({
				t: "rpcResult",
				id: 10,
				ok: false,
				error: "tab 1 is not in the omp tab group",
			}),
		);
	});
	it("rejects Target escape commands and sanitizes same-tab auto-attach", async () => {
		const socket = await prepareScope([{ ...scopedTab }], [{ ...ompGroup }]);
		const forbidden = [
			"Target.getTargets",
			"Target.setDiscoverTargets",
			"Target.attachToTarget",
			"Target.createTarget",
			"Target.activateTarget",
			"Target.closeTarget",
			"Target.createBrowserContext",
			"Target.attachToBrowserTarget",
			"Target.autoAttachRelated",
			"Target.exposeDevToolsProtocol",
		];
		for (const [index, method] of forbidden.entries()) {
			socket.receive(JSON.stringify({ t: "rpc", id: 20 + index, op: "send", tabId: 1, method }));
		}
		await flush();

		expect(fake.calls.debugger.sendCommand).toHaveLength(0);
		for (const [index, method] of forbidden.entries()) {
			expect(messages(socket)).toContainEqual(
				expect.objectContaining({
					t: "rpcResult",
					id: 20 + index,
					ok: false,
					error: `${method} is not allowed through the omp browser relay`,
				}),
			);
		}

		socket.receive(
			JSON.stringify({
				t: "rpc",
				id: 30,
				op: "send",
				tabId: 1,
				method: "Target.setAutoAttach",
				params: {
					autoAttach: true,
					waitForDebuggerOnStart: true,
					flatten: false,
					filter: [{ type: "page" }],
				},
			}),
		);
		await flush();
		expect(fake.calls.debugger.sendCommand).toContainEqual(
			expect.objectContaining({
				target: { tabId: 1 },
				method: "Target.setAutoAttach",
				params: {
					autoAttach: true,
					waitForDebuggerOnStart: true,
					flatten: true,
					filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
				},
			}),
		);
		expect(messages(socket)).toContainEqual(expect.objectContaining({ t: "rpcResult", id: 30, ok: true }));
	});

	it("forwards only relationship-proven same-tab OOPIF and dedicated-worker child events", async () => {
		const socket = await prepareScope([{ ...scopedTab }], [{ ...ompGroup }]);
		const beforeAllowed = messages(socket).length;
		for (const params of [
			{
				sessionId: "same-tab-oopif",
				targetInfo: {
					targetId: "oopif",
					type: "iframe",
					title: "",
					url: "https://example.com/frame",
					attached: false,
					canAccessOpener: false,
					parentId: "parent-page",
				},
			},
			{
				sessionId: "same-tab-worker",
				targetInfo: {
					targetId: "worker",
					type: "worker",
					title: "",
					url: "https://example.com/worker.js",
					attached: false,
					canAccessOpener: false,
					parentFrameId: "parent-frame",
				},
			},
		]) {
			fake.events.debugger.onEvent.emit({ tabId: 1 }, "Target.attachedToTarget", params);
		}
		expect(
			messages(socket)
				.slice(beforeAllowed)
				.filter(message => message.t === "cdpEvent"),
		).toHaveLength(2);

		const beforeRejected = messages(socket).length;
		for (const params of [
			{
				sessionId: "popup",
				targetInfo: {
					targetId: "popup",
					type: "page",
					title: "",
					url: "https://example.com/popup",
					attached: false,
					canAccessOpener: true,
					openerId: "parent-page",
				},
			},
			{
				sessionId: "shared-worker",
				targetInfo: {
					targetId: "shared-worker",
					type: "shared_worker",
					title: "",
					url: "https://example.com/shared.js",
					attached: false,
					canAccessOpener: false,
					parentFrameId: "parent-frame",
				},
			},
			{
				sessionId: "service-worker",
				targetInfo: {
					targetId: "service-worker",
					type: "service_worker",
					title: "",
					url: "https://example.com/service.js",
					attached: false,
					canAccessOpener: false,
				},
			},
		]) {
			fake.events.debugger.onEvent.emit({ tabId: 1 }, "Target.attachedToTarget", params);
		}
		expect(messages(socket).slice(beforeRejected)).not.toContainEqual(expect.objectContaining({ t: "cdpEvent" }));
	});
});
