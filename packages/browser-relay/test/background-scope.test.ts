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
});
