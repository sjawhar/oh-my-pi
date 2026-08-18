import { cfgDisplayReduceMotion } from "../modes/settings";
import { isSettingsInitialized, settings } from "./settings";

export type ReduceMotionLevel = "off" | "on" | "strict";

export function reduceMotionLevel(): ReduceMotionLevel {
	return isSettingsInitialized() ? cfgDisplayReduceMotion.get(settings) : "off";
}

export function isReduceMotion(): boolean {
	return reduceMotionLevel() !== "off";
}
