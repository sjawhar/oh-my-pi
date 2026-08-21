import { describe, expect, it } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

/** A relay→extension RPC narrowed to one op, tab ids and other operation fields included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();

	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}

	close(): void {}

	rpcs<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter((message): message is ExtRpc<Op> => message.t === "rpc" && message.op === op);
	}

	/** RPC requests of `op` not yet answered through {@link ack}. */
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.rpcs(op).filter(message => !this.#acked.has(message.id));
	}

	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

/** Downstream puppeteer-side socket capturing bridge emissions. */
class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];

	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}

	close(): void {}

	sessionFor(commandId: number): string | undefined {
		const message = this.messages.find(candidate => candidate.id === commandId);
		const result =
			message && "result" in message && message.result && typeof message.result === "object"
				? message.result
				: undefined;
		return result && "sessionId" in result && typeof result.sessionId === "string" ? result.sessionId : undefined;
	}
}

function tab(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function connect(bridge: RelayBridge, socket: FakeExtSocket, tabs: TabSnapshot[]): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs,
			attachedTabIds: [],
		}),
	);
}

/** Answer every unanswered extension RPC of `op` with `ok: true` and `result`. */
function ack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

/** Flush the RPC microtask chains (no timers involved). */
async function flush(): Promise<void> {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

let messageId = 100;

/** Attach to a tab's page target and return the minted page session id. */
async function attachPage(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connectionId: number,
	tabId: number,
): Promise<string> {
	const id = ++messageId;
	bridge.cdpMessage(
		connectionId,
		JSON.stringify({
			id,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${tabId}`, flatten: true },
		}),
	);
	ack(bridge, ext, "attach");
	await flush();
	const sessionId = cdp.sessionFor(id);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

function targetCreatedMessages(socket: FakeCdpSocket): Array<Record<string, unknown>> {
	return socket.messages.filter(message => message.method === "Target.targetCreated");
}

describe("RelayBridge scope enforcement", () => {
	it("sends the extension its configured scope before the hello handshake", () => {
		const allTabsBridge = new RelayBridge({ allTabs: true });
		const allTabsExt = new FakeExtSocket();
		allTabsBridge.extConnected(allTabsExt);
		expect(allTabsExt.messages[0]).toEqual({ t: "config", allTabs: true });

		const scopedBridge = new RelayBridge();
		const scopedExt = new FakeExtSocket();
		scopedBridge.extConnected(scopedExt);
		expect(scopedExt.messages[0]).toEqual({ t: "config", allTabs: false });
	});

	it("rejects an unknown target attach without asking Chrome to attach", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connectionId,
			JSON.stringify({ id: ++messageId, method: "Target.attachToTarget", params: { targetId: "PAGE7" } }),
		);
		await flush();

		expect(cdp.messages).toContainEqual(
			expect.objectContaining({ error: expect.objectContaining({ message: "No target with id PAGE7" }) }),
		);
		expect(ext.rpcs("attach")).toHaveLength(0);
	});

	it("rejects unknown target close and activate requests without forwarding them", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connectionId,
			JSON.stringify({ id: ++messageId, method: "Target.closeTarget", params: { targetId: "PAGE7" } }),
		);
		bridge.cdpMessage(
			connectionId,
			JSON.stringify({ id: ++messageId, method: "Target.activateTarget", params: { targetId: "PAGE7" } }),
		);
		await flush();

		expect(cdp.messages).toContainEqual(
			expect.objectContaining({ error: expect.objectContaining({ message: "No target with id PAGE7" }) }),
		);
		expect(ext.rpcs("removeTab")).toHaveLength(0);
		expect(ext.rpcs("activateTab")).toHaveLength(0);
	});

	it("destroys discovered targets when the extension retracts a tab", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connectionId, JSON.stringify({ id: ++messageId, method: "Target.setDiscoverTargets" }));
		await flush();

		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		expect(cdp.messages).toContainEqual(
			expect.objectContaining({ method: "Target.targetDestroyed", params: { targetId: "PAGE1" } }),
		);
		expect(cdp.messages).toContainEqual(
			expect.objectContaining({ method: "Target.targetDestroyed", params: { targetId: "TAB1" } }),
		);
		expect(bridge.listTargets()).toEqual([]);
	});

	it("rejects stale session commands after revocation without forwarding them to Chrome", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connectionId, 1);

		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		bridge.cdpMessage(connectionId, JSON.stringify({ id: ++messageId, sessionId, method: "Runtime.evaluate" }));
		await flush();

		expect(cdp.messages).toContainEqual(
			expect.objectContaining({ error: expect.objectContaining({ message: `Unknown session id ${sessionId}` }) }),
		);
		expect(ext.rpcs("send")).toHaveLength(0);
	});

	it("hides stale targets until the replacement extension sends hello", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		bridge.extClosed(ext);
		expect(bridge.listTargets()).toEqual([]);

		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connectionId, JSON.stringify({ id: ++messageId, method: "Target.setDiscoverTargets" }));
		await flush();
		expect(targetCreatedMessages(cdp)).toHaveLength(0);
		bridge.cdpMessage(
			connectionId,
			JSON.stringify({ id: ++messageId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();
		expect(cdp.messages).toContainEqual(
			expect.objectContaining({ error: expect.objectContaining({ message: "relay extension is not connected" }) }),
		);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })]);
		await flush();
		expect(targetCreatedMessages(cdp)).toContainEqual(
			expect.objectContaining({
				params: expect.objectContaining({ targetInfo: expect.objectContaining({ targetId: "PAGE1" }) }),
			}),
		);
		expect(bridge.listTargets()).toContainEqual(expect.objectContaining({ id: "PAGE1" }));
	});

	it("replays auto-attach after an extension reconnect", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		bridge.extClosed(ext);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connectionId, JSON.stringify({ id: ++messageId, method: "Target.setAutoAttach" }));
		await flush();
		expect(cdp.messages.filter(message => message.method === "Target.attachedToTarget")).toHaveLength(0);

		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1 })]);
		ack(bridge, ext2, "attach");
		await flush();
		expect(cdp.messages).toContainEqual(
			expect.objectContaining({
				method: "Target.attachedToTarget",
				params: expect.objectContaining({ targetInfo: expect.objectContaining({ targetId: "TAB1" }) }),
			}),
		);
	});

	it("returns a created tab as a target without any grouping side effect", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		const id = ++messageId;
		bridge.cdpMessage(
			connectionId,
			JSON.stringify({ id, method: "Target.createTarget", params: { url: "https://example.com/new" } }),
		);
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 9, groupId: 42 }) });
		await flush();

		expect(cdp.messages).toContainEqual(expect.objectContaining({ id, result: { targetId: "PAGE9" } }));
		expect(bridge.listTargets()).toContainEqual(expect.objectContaining({ id: "PAGE9" }));
	});
	it("does not forward page-session Target escapes but preserves same-tab auto-attach", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connectionId, 1);
		const forbidden = [
			{ method: "Target.attachToTarget", params: { targetId: "unscoped-target", flatten: true } },
			{ method: "Target.createTarget", params: { url: "https://example.com/escape" } },
			{ method: "Target.getTargets" },
		];
		const ids: number[] = [];
		for (const command of forbidden) {
			const id = ++messageId;
			ids.push(id);
			bridge.cdpMessage(connectionId, JSON.stringify({ id, sessionId, ...command }));
		}
		await flush();

		expect(ext.rpcs("send")).toHaveLength(0);
		for (const [index, command] of forbidden.entries()) {
			expect(cdp.messages).toContainEqual(
				expect.objectContaining({
					id: ids[index],
					error: expect.objectContaining({
						message: `${command.method} is not allowed through the omp browser relay`,
					}),
				}),
			);
		}

		const autoAttachId = ++messageId;
		bridge.cdpMessage(
			connectionId,
			JSON.stringify({ id: autoAttachId, sessionId, method: "Target.setAutoAttach", params: { autoAttach: true } }),
		);
		await flush();
		expect(ext.rpcs("send")).toContainEqual(expect.objectContaining({ method: "Target.setAutoAttach" }));
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages).toContainEqual(expect.objectContaining({ id: autoAttachId, result: {} }));
	});
	it("does not associate a child session Chrome identifies with another tab", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connectionId = bridge.cdpConnected(cdp);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "foreign-child", targetInfo: { tabId: 2 } },
			}),
		);
		const id = ++messageId;
		bridge.cdpMessage(connectionId, JSON.stringify({ id, sessionId: "foreign-child", method: "Runtime.evaluate" }));
		await flush();

		expect(cdp.messages).toContainEqual(
			expect.objectContaining({
				id,
				error: expect.objectContaining({ message: "Unknown session id foreign-child" }),
			}),
		);
		expect(ext.rpcs("send")).toHaveLength(0);
	});
});
