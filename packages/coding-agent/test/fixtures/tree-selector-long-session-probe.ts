import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

// A long linear session with one fork near its leaf, the shape of a real long session.
const ENTRIES = 10_000;

async function liveBytes(): Promise<number> {
	Bun.gc(true);
	Bun.gc(true);
	await Bun.sleep(50);
	return process.memoryUsage().heapUsed;
}

function userNode(index: number, parentId: string | null): SessionTreeNode {
	const entry = {
		id: `e${index}`,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role: "user", content: `turn ${index}`, timestamp: index } as AgentMessage,
	} as SessionEntry;
	return { entry, children: [] };
}

const root = userNode(0, null);
let leaf = root;
let fork = root;
for (let index = 1; index < ENTRIES; index++) {
	const next = userNode(index, leaf.entry.id);
	leaf.children.push(next);
	leaf = next;
	if (index === ENTRIES - 3) fork = next;
}
fork.children.push(userNode(ENTRIES, fork.entry.id));

await initTheme(false, undefined, undefined, "dark", "light");
const baseline = await liveBytes();
const selector = new TreeSelectorComponent(
	[root],
	leaf.entry.id,
	40,
	() => {},
	() => {},
);
selector.render(120);
const retainedBytes = Math.max(0, (await liveBytes()) - baseline);
const selected = selector.getTreeList().pickerView().selected;
await Bun.write(Bun.stdout, `${retainedBytes}\n${selected}\n`);
