/**
 * OMP Browser Relay — MV3 service worker.
 *
 * The user's Chrome tab group named "omp" is this extension's access-control
 * list. The relay may drive only announced members; every group transition
 * tombstones affected tabs synchronously before the membership lookup begins.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the
 * worker alive while connected (Chrome 116+); a chrome.alarms tick revives it
 * and re-dials after Chrome reaps it while disconnected.
 */
import type {
	ExtToRelayMessage,
	RelayToExtMessage,
	TabSnapshot,
} from "../../coding-agent/src/tools/browser/relay/protocol";

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const OMP_GROUP = { title: "omp", color: "cyan" } as const;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
let allTabs = false;
/** Tab ids currently announced to the relay. */
const announced = new Set<number>();
/** Tab id → number of pending membership recomputations. */
const suspended = new Map<number, number>();

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/** Serialize all group joins and scope recomputations. */
let scopeOps: Promise<unknown> = Promise.resolve();
function enqueueScopeOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = scopeOps.then(fn, fn);
	scopeOps = result.catch(() => {});
	return result;
}

function suspend(tabId: number): void {
	suspended.set(tabId, (suspended.get(tabId) ?? 0) + 1);
}

function release(tabId: number): void {
	const count = suspended.get(tabId);
	if (count === undefined) return;
	if (count <= 1) {
		suspended.delete(tabId);
		return;
	}
	suspended.set(tabId, count - 1);
}

/** Query Chrome's pattern-matched titles, then enforce exact ACL title equality. */
async function ompGroupIds(): Promise<Set<number>> {
	const groups = await chrome.tabGroups.query({ title: OMP_GROUP.title }).catch(() => []);
	return new Set(groups.filter(group => group.title === OMP_GROUP.title).map(group => group.id));
}

async function tabInScope(tabId: number): Promise<boolean> {
	if (allTabs) return true;
	try {
		const tab = await chrome.tabs.get(tabId);
		return (await ompGroupIds()).has(tab.groupId);
	} catch {
		return false;
	}
}

function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

async function revoke(tabId: number): Promise<void> {
	await chrome.debugger.detach({ tabId }).catch(() => {});
	if (announced.delete(tabId)) post({ t: "tabRemoved", tabId });
}

async function applyScopeTransition(tab: TabSnapshot | null, member: boolean): Promise<void> {
	if (!tab) return;
	if (member) {
		if (announced.has(tab.tabId)) {
			post({ t: "tabUpdated", tab });
			return;
		}
		announced.add(tab.tabId);
		post({ t: "tabCreated", tab });
		return;
	}
	if (!announced.delete(tab.tabId)) return;
	await chrome.debugger.detach({ tabId: tab.tabId }).catch(() => {});
	post({ t: "tabRemoved", tabId: tab.tabId });
}

async function transitionSnapshot(tab: ChromeTab): Promise<void> {
	const snap = snapshot(tab);
	if (!snap) return;
	const member = allTabs || (await ompGroupIds()).has(snap.groupId);
	await applyScopeTransition(snap, member);
}

function queueScopeCheck(tabId: number): void {
	void enqueueScopeOp(async () => {
		try {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			const snap = tab === null ? null : snapshot(tab);
			const member = snap !== null && (allTabs || (await ompGroupIds()).has(snap.groupId));
			await applyScopeTransition(snap, member);
			if (!member && snap === null && announced.delete(tabId)) {
				await chrome.debugger.detach({ tabId }).catch(() => {});
				post({ t: "tabRemoved", tabId });
			}
		} catch {
			await revoke(tabId);
		} finally {
			release(tabId);
		}
	});
}

async function reconcileScope(tabIds: number[]): Promise<void> {
	try {
		const tabs = await chrome.tabs.query({});
		const groupIds = await ompGroupIds();
		const seen = new Set<number>();
		for (const tab of tabs) {
			const snap = snapshot(tab);
			if (!snap) continue;
			seen.add(snap.tabId);
			await applyScopeTransition(snap, allTabs || groupIds.has(snap.groupId));
		}
		for (const tabId of tabIds) {
			if (!seen.has(tabId) && announced.delete(tabId)) {
				await chrome.debugger.detach({ tabId }).catch(() => {});
				post({ t: "tabRemoved", tabId });
			}
		}
	} catch {
		for (const tabId of tabIds) await revoke(tabId);
	} finally {
		for (const tabId of tabIds) release(tabId);
	}
}

function queueScopeReconcile(): void {
	if (allTabs) return;
	const tabIds = [...announced];
	for (const tabId of tabIds) suspend(tabId);
	void enqueueScopeOp(() => reconcileScope(tabIds));
}

/** Join a newly-created tab to the existing per-window ACL group or create it. */
async function joinOmpGroup(tabId: number, windowId: number): Promise<void> {
	const groups = (await chrome.tabGroups.query({ title: OMP_GROUP.title, windowId })).filter(
		group => group.title === OMP_GROUP.title,
	);
	let groupId: number;
	if (groups[0]) {
		groupId = groups[0].id;
		for (const duplicate of groups.slice(1)) {
			const duplicateTabs = await chrome.tabs.query({ groupId: duplicate.id });
			const duplicateIds = duplicateTabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
			if (duplicateIds.length > 0) await chrome.tabs.group({ tabIds: duplicateIds, groupId });
		}
		await chrome.tabs.group({ tabIds: [tabId], groupId });
	} else {
		groupId = await chrome.tabs.group({ tabIds: [tabId] });
	}
	await chrome.tabGroups.update(groupId, OMP_GROUP);
}

async function buildHello(): Promise<ExtToRelayMessage> {
	return await enqueueScopeOp(async () => {
		const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
		const groupIds = await ompGroupIds();
		const snapshots = tabs
			.map(snapshot)
			.filter((snap): snap is TabSnapshot => snap !== null && (allTabs || groupIds.has(snap.groupId)));
		announced.clear();
		for (const snap of snapshots) announced.add(snap.tabId);
		suspended.clear();

		const tabsById = new Map(tabs.flatMap(tab => (tab.id === undefined ? [] : [[tab.id, tab] as const])));
		const attachedTabIds: number[] = [];
		for (const target of targets) {
			if (!target.attached || target.tabId === undefined) continue;
			const tab = tabsById.get(target.tabId);
			if (!allTabs && (!tab || !groupIds.has(tab.groupId))) {
				await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
				continue;
			}
			attachedTabIds.push(target.tabId);
		}

		const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
		return {
			t: "hello",
			userAgent: navigator.userAgent,
			browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
			tabs: snapshots,
			attachedTabIds,
		};
	});
}

async function assertTabInScope(tabId: number): Promise<void> {
	if (allTabs) return;
	if (suspended.has(tabId)) await enqueueScopeOp(() => Promise.resolve());
	if (await tabInScope(tabId)) return;
	await chrome.debugger.detach({ tabId }).catch(() => {});
	if (announced.delete(tabId)) post({ t: "tabRemoved", tabId });
	throw new Error(`tab ${tabId} is not in the omp tab group`);
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>): Promise<unknown> {
	switch (msg.op) {
		case "attach":
			await assertTabInScope(msg.tabId);
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			return {};
		case "detach":
			await chrome.debugger.detach({ tabId: msg.tabId });
			return {};
		case "send":
			await assertTabInScope(msg.tabId);
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url });
			if (tab.id === undefined) throw new Error("created tab has no id");
			if (!allTabs) {
				try {
					await enqueueScopeOp(() => joinOmpGroup(tab.id!, tab.windowId));
				} catch {
					await chrome.tabs.remove(tab.id).catch(() => {});
					throw new Error("created tab could not join the omp tab group");
				}
			}
			const fresh = await chrome.tabs.get(tab.id);
			const snap = snapshot(fresh);
			if (!snap) throw new Error("created tab has no id");
			announced.add(snap.tabId);
			return { tab: snap };
		}
		case "removeTab":
			await assertTabInScope(msg.tabId);
			await chrome.tabs.remove(msg.tabId);
			return {};
		case "activateTab": {
			await assertTabInScope(msg.tabId);
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "ungroup":
			await enqueueScopeOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
			return {};
	}
}

function handleRelayMessage(raw: string): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	if (msg.t === "config") {
		const changed = allTabs !== msg.allTabs;
		allTabs = msg.allTabs;
		if (changed) void buildHello().then(hello => post(hello));
		return;
	}
	void runRpc(msg)
		.then(result => post({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err: unknown) => {
			post({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	const settings = await loadSettings();
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		allTabs = false;
		void setBadge(true);
		void buildHello().then(hello => post(hello));
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = event => {
		if (typeof event.data === "string") handleRelayMessage(event.data);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	if (!allTabs && (suspended.has(source.tabId) || !announced.has(source.tabId))) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	post({ t: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onCreated.addListener(tab => {
	void enqueueScopeOp(() => transitionSnapshot(tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (!allTabs && changeInfo.groupId !== undefined) {
		suspend(tabId);
		queueScopeCheck(tabId);
		return;
	}
	void enqueueScopeOp(() => transitionSnapshot(tab));
});

chrome.tabs.onMoved.addListener(tabId => {
	if (!allTabs && announced.has(tabId)) {
		suspend(tabId);
		queueScopeCheck(tabId);
	}
});

chrome.tabs.onDetached.addListener(tabId => {
	if (!allTabs && announced.has(tabId)) {
		suspend(tabId);
		queueScopeCheck(tabId);
	}
});

chrome.tabs.onAttached.addListener(tabId => {
	if (!allTabs) {
		suspend(tabId);
		queueScopeCheck(tabId);
	}
});

chrome.tabs.onRemoved.addListener(tabId => {
	announced.delete(tabId);
	suspended.delete(tabId);
	post({ t: "tabRemoved", tabId });
});

chrome.tabGroups.onCreated.addListener(() => queueScopeReconcile());
chrome.tabGroups.onUpdated.addListener(() => queueScopeReconcile());
chrome.tabGroups.onRemoved.addListener(() => queueScopeReconcile());

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "omp-relay-keepalive") void connect();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
	if (areaName !== "local") return;
	// Settings changed: drop the current connection and re-dial with new ones.
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());

void connect();
