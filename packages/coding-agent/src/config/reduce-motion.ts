export type ReduceMotionLevel = "off" | "on" | "strict";

// Process-wide mirror of the effective `display.reduceMotion` setting, pushed
// by Settings (the global instance) on init and on every effective change.
// Kept as a leaf module on purpose: the startup prepaint scene (welcome,
// theme) reads it, and importing Settings from here would drag settings'
// whole module graph — discovery, MCP, catalog, session storage — into that
// scene before the first frame. `startup-composer-graph.test.ts` guards this.
let level: ReduceMotionLevel = "off";

export function setReduceMotionLevel(next: ReduceMotionLevel): void {
	level = next;
}

export function reduceMotionLevel(): ReduceMotionLevel {
	return level;
}

export function isReduceMotion(): boolean {
	return level !== "off";
}
