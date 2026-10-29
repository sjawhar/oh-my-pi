import type { ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { UsageFallbackConfirmation } from "./agent-session-types";

/**
 * The question a person is asked before a reserve-bound model is left. Every
 * surface that can ask it — TUI, ACP, RPC — asks it in these words, so a host
 * that matches on the title sees the same dialog wherever the session runs.
 */
export function usageReserveConfirmPrompt(confirmation: UsageFallbackConfirmation): {
	title: string;
	message: string;
} {
	const reserve =
		confirmation.remainingPercent === undefined
			? "inside the configured reserve margin"
			: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
	return {
		title: "Coding-plan reserve reached",
		message: `${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
	};
}

/** Describe the health snapshot that actually caused a preflight switch. */
export function describeUsageFallback(health: ModelUsageHealth, reservePercent: number): string {
	const condition =
		health.state === "reserve"
			? `available quota is at or below the ${reservePercent}% reserve`
			: health.accounts.length === 0
				? "no account is eligible for this model's plan requirements"
				: "all eligible accounts are quota-exhausted or temporarily blocked";
	const now = Date.now();
	let earliestReset = Infinity;
	for (const account of health.accounts) {
		const reset = account.resetsAt;
		if (reset !== undefined && Number.isFinite(reset) && reset > now && reset < earliestReset) {
			earliestReset = reset;
		}
	}
	const reset = Number.isFinite(earliestReset)
		? ` Earliest reported reset in ${formatDuration(earliestReset - now)}.`
		: "";
	return `Usage preflight: ${condition}.${reset} No request was sent to the source model for this attempt.`;
}
