import { expect, test } from "bun:test";
import { AgentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause";
import { holdAllBeforeDispatch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/dispatch-hold";

test("dispatchHold: pause re-engaged while caller's async next runs", async () => {
	const gate = new AgentPauseGate();
	gate.pause();
	const nextStarted = Promise.withResolvers<void>();
	const nextRelease = Promise.withResolvers<void>();
	const hold = gate.dispatchHold(undefined, async () => {
		nextStarted.resolve();
		await nextRelease.promise;
	});
	let dispatched = false;
	const p = holdAllBeforeDispatch([hold]).then(() => {
		dispatched = true;
	});
	gate.resume();
	await nextStarted.promise;
	gate.pause(); // human re-engages /pause while next() awaits
	nextRelease.resolve();
	await p;
	console.log(`dispatched=${dispatched} pausedAtDispatch=${gate.paused}`);
	gate.resume();
});
