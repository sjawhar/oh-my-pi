type Listener<Args extends unknown[]> = (...args: Args) => void;

export class FakeEvent<Args extends unknown[]> {
	readonly listeners: Array<Listener<Args>> = [];

	addListener(listener: Listener<Args>): void {
		this.listeners.push(listener);
	}

	removeListener(listener: Listener<Args>): void {
		const index = this.listeners.indexOf(listener);
		if (index >= 0) this.listeners.splice(index, 1);
	}

	emit(...args: Args): void {
		for (const listener of [...this.listeners]) listener(...args);
	}
}

interface TabGroupQuery {
	title?: string;
	windowId?: number;
}

interface TabQuery {
	groupId?: number;
	url?: string;
}

interface GroupQueryGate {
	promise: Promise<ChromeTabGroup[]>;
	resolve(groups: ChromeTabGroup[]): void;
}

let nextTabId = 100;
let nextGroupId = 100;
let nextTabsQueryFailure: Error | null = null;
let nextTabsGroupFailure: Error | null = null;
let nextGroupQueryGate: GroupQueryGate | null = null;

const localStorage: Record<string, unknown> = {};
const sessionStorage: Record<string, unknown> = {};

function matchingGroups(query: TabGroupQuery): ChromeTabGroup[] {
	return fake.groups.filter(group => {
		if (query.windowId !== undefined && group.windowId !== query.windowId) return false;
		// Chrome's title query is a pattern match. The extension must apply exact
		// equality to this result before it treats a group as the ACL.
		return query.title === undefined || (group.title ?? "").includes(query.title);
	});
}

function matchingTabs(query: TabQuery): ChromeTab[] {
	return fake.tabs.filter(tab => {
		if (query.groupId !== undefined && tab.groupId !== query.groupId) return false;
		if (query.url !== undefined && tab.url !== query.url) return false;
		return true;
	});
}

function tabById(tabId: number): ChromeTab {
	const tab = fake.tabs.find(candidate => candidate.id === tabId);
	if (!tab) throw new Error(`tab ${tabId} does not exist`);
	return tab;
}

export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static readonly instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readonly sent: string[] = [];

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(message: string): void {
		this.sent.push(message);
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.({} as Event);
	}

	receive(message: string): void {
		this.onmessage?.({ data: message } as MessageEvent<string>);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({} as CloseEvent);
	}
}

export const fake = {
	tabs: [] as ChromeTab[],
	groups: [] as ChromeTabGroup[],
	debuggerTargets: [] as ChromeDebuggerTargetInfo[],
	calls: {
		tabs: {
			create: [] as Array<{ url?: string; active?: boolean }>,
			remove: [] as number[],
			update: [] as Array<{ tabId: number; active?: boolean }>,
			group: [] as Array<{ tabIds: number[]; groupId?: number }>,
			ungroup: [] as number[][],
		},
		tabGroups: {
			update: [] as Array<{ groupId: number; title?: string; color?: string; collapsed?: boolean }>,
		},
		windows: {
			update: [] as Array<{ windowId: number; focused?: boolean }>,
		},
		debugger: {
			attach: [] as Array<{ target: ChromeDebuggerSession; version: string }>,
			detach: [] as ChromeDebuggerSession[],
			sendCommand: [] as Array<{
				target: ChromeDebuggerSession;
				method: string;
				params?: Record<string, unknown>;
			}>,
		},
	},
	events: {
		tabs: {
			onCreated: new FakeEvent<[ChromeTab]>(),
			onUpdated: new FakeEvent<[number, ChromeTabChangeInfo, ChromeTab]>(),
			onRemoved: new FakeEvent<[number, { windowId: number }]>(),
			onMoved: new FakeEvent<[number, { windowId: number; fromIndex: number; toIndex: number }]>(),
			onDetached: new FakeEvent<[number, { oldWindowId: number; oldPosition: number }]>(),
			onAttached: new FakeEvent<[number, { newWindowId: number; newPosition: number }]>(),
		},
		tabGroups: {
			onCreated: new FakeEvent<[ChromeTabGroup]>(),
			onUpdated: new FakeEvent<[ChromeTabGroup]>(),
			onRemoved: new FakeEvent<[ChromeTabGroup]>(),
		},
		debugger: {
			onEvent: new FakeEvent<[ChromeDebuggerSession, string, Record<string, unknown> | undefined]>(),
			onDetach: new FakeEvent<[ChromeDebuggerSession, string]>(),
		},
		storage: new FakeEvent<[Record<string, unknown>, string]>(),
		alarms: new FakeEvent<[{ name: string }]>(),
		action: new FakeEvent<[ChromeTab]>(),
		runtime: {
			onInstalled: new FakeEvent<[]>(),
			onStartup: new FakeEvent<[]>(),
		},
	},
	reset(): void {
		this.tabs.length = 0;
		this.groups.length = 0;
		this.debuggerTargets.length = 0;
		for (const calls of Object.values(this.calls.tabs)) calls.length = 0;
		for (const calls of Object.values(this.calls.tabGroups)) calls.length = 0;
		for (const calls of Object.values(this.calls.windows)) calls.length = 0;
		for (const calls of Object.values(this.calls.debugger)) calls.length = 0;
		for (const socket of FakeWebSocket.instances) socket.sent.length = 0;
		nextTabId = 100;
		nextGroupId = 100;
		nextTabsQueryFailure = null;
		nextTabsGroupFailure = null;
		nextGroupQueryGate = null;
		for (const key of Object.keys(localStorage)) delete localStorage[key];
		for (const key of Object.keys(sessionStorage)) delete sessionStorage[key];
	},
	holdNextGroupQuery(): { release(groups: ChromeTabGroup[]): void } {
		if (nextGroupQueryGate) throw new Error("a group query is already held");
		const { promise, resolve } = Promise.withResolvers<ChromeTabGroup[]>();
		nextGroupQueryGate = { promise, resolve };
		return {
			release(groups: ChromeTabGroup[]): void {
				fake.groups.splice(0, fake.groups.length, ...groups);
				resolve(groups);
			},
		};
	},
	failNextTabsQuery(error: Error): void {
		nextTabsQueryFailure = error;
	},
	failNextTabsGroup(error: Error): void {
		nextTabsGroupFailure = error;
	},
};

const chromeFake = {
	tabs: {
		async query(query: TabQuery): Promise<ChromeTab[]> {
			if (nextTabsQueryFailure) {
				const error = nextTabsQueryFailure;
				nextTabsQueryFailure = null;
				throw error;
			}
			return matchingTabs(query);
		},
		async get(tabId: number): Promise<ChromeTab> {
			return tabById(tabId);
		},
		async create(properties: { url?: string; active?: boolean }): Promise<ChromeTab> {
			fake.calls.tabs.create.push(properties);
			const tab: ChromeTab = {
				id: nextTabId++,
				url: properties.url,
				title: "",
				active: properties.active ?? false,
				windowId: 1,
				pinned: false,
				groupId: -1,
			};
			fake.tabs.push(tab);
			return tab;
		},
		async remove(tabId: number): Promise<void> {
			fake.calls.tabs.remove.push(tabId);
			const index = fake.tabs.findIndex(tab => tab.id === tabId);
			if (index >= 0) fake.tabs.splice(index, 1);
		},
		async update(tabId: number, properties: { active?: boolean }): Promise<ChromeTab> {
			fake.calls.tabs.update.push({ tabId, ...properties });
			const tab = tabById(tabId);
			if (properties.active !== undefined) tab.active = properties.active;
			return tab;
		},
		async group(options: { tabIds: number[]; groupId?: number }): Promise<number> {
			fake.calls.tabs.group.push(options);
			if (nextTabsGroupFailure) {
				const error = nextTabsGroupFailure;
				nextTabsGroupFailure = null;
				throw error;
			}
			const groupId = options.groupId ?? nextGroupId++;
			if (!fake.groups.some(group => group.id === groupId)) {
				fake.groups.push({ id: groupId, windowId: tabById(options.tabIds[0]!).windowId });
			}
			for (const tabId of options.tabIds) tabById(tabId).groupId = groupId;
			return groupId;
		},
		async ungroup(tabIds: number[]): Promise<void> {
			fake.calls.tabs.ungroup.push(tabIds);
			for (const tabId of tabIds) tabById(tabId).groupId = -1;
		},
		onCreated: fake.events.tabs.onCreated,
		onUpdated: fake.events.tabs.onUpdated,
		onRemoved: fake.events.tabs.onRemoved,
		onMoved: fake.events.tabs.onMoved,
		onDetached: fake.events.tabs.onDetached,
		onAttached: fake.events.tabs.onAttached,
	},
	tabGroups: {
		async query(query: TabGroupQuery): Promise<ChromeTabGroup[]> {
			if (nextGroupQueryGate) {
				const gate = nextGroupQueryGate;
				nextGroupQueryGate = null;
				return await gate.promise;
			}
			return matchingGroups(query);
		},
		async update(
			groupId: number,
			properties: { title?: string; color?: string; collapsed?: boolean },
		): Promise<ChromeTabGroup> {
			fake.calls.tabGroups.update.push({ groupId, ...properties });
			const group = fake.groups.find(candidate => candidate.id === groupId);
			if (!group) throw new Error(`group ${groupId} does not exist`);
			Object.assign(group, properties);
			return group;
		},
		onCreated: fake.events.tabGroups.onCreated,
		onUpdated: fake.events.tabGroups.onUpdated,
		onRemoved: fake.events.tabGroups.onRemoved,
	},
	windows: {
		async update(windowId: number, properties: { focused?: boolean }): Promise<void> {
			fake.calls.windows.update.push({ windowId, ...properties });
		},
	},
	debugger: {
		async attach(target: ChromeDebuggerSession, version: string): Promise<void> {
			fake.calls.debugger.attach.push({ target, version });
		},
		async detach(target: ChromeDebuggerSession): Promise<void> {
			fake.calls.debugger.detach.push(target);
		},
		async sendCommand(
			target: ChromeDebuggerSession,
			method: string,
			params?: Record<string, unknown>,
		): Promise<Record<string, unknown>> {
			fake.calls.debugger.sendCommand.push({ target, method, params });
			return {};
		},
		async getTargets(): Promise<ChromeDebuggerTargetInfo[]> {
			return fake.debuggerTargets;
		},
		onEvent: fake.events.debugger.onEvent,
		onDetach: fake.events.debugger.onDetach,
	},
	storage: {
		local: {
			async get(defaults: Record<string, unknown>): Promise<Record<string, unknown>> {
				return { ...defaults, ...localStorage };
			},
			async set(items: Record<string, unknown>): Promise<void> {
				Object.assign(localStorage, items);
			},
		},
		session: {
			async get(defaults: Record<string, unknown>): Promise<Record<string, unknown>> {
				return { ...defaults, ...sessionStorage };
			},
			async set(items: Record<string, unknown>): Promise<void> {
				Object.assign(sessionStorage, items);
			},
		},
		onChanged: fake.events.storage,
	},
	alarms: {
		create(): void {},
		onAlarm: fake.events.alarms,
	},
	action: {
		async setBadgeText(): Promise<void> {},
		async setBadgeBackgroundColor(): Promise<void> {},
		onClicked: fake.events.action,
	},
	runtime: {
		async openOptionsPage(): Promise<void> {},
		onInstalled: fake.events.runtime.onInstalled,
		onStartup: fake.events.runtime.onStartup,
	},
};

Object.assign(globalThis, { chrome: chromeFake, WebSocket: FakeWebSocket });
if (!globalThis.navigator) {
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Chrome/151.0.0.0" } });
}
