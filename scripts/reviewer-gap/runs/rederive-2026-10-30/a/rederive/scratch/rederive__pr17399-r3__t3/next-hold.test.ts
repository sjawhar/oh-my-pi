import { expect, test } from "bun:test";
import { AgentPauseGate } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/agent/src/pause.ts";
import { holdAllBeforeDispatch, holdBeforeDispatch } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/dispatch-hold.ts";

// `next` = a caller's own hold that awaits something (I/O, a permit, a check).
const slowNext = () => Bun.sleep(40);

test("dispatchHold(signal, next): pause engaged while `next` waits is not honoured", async () => {
	const gate = new AgentPauseGate();
	const hold = gate.dispatchHold(undefined, slowNext); // agent-session #sideStreamFn / judgment pauseHeld shape
	setTimeout(() => gate.pause(), 10); // `/pause` lands while next() is pending
	let dispatched = false;
	const p = holdBeforeDispatch(hold).then(() => {
		dispatched = true;
	});
	await Bun.sleep(80);
	console.log(`composed via next: dispatched=${dispatched} gate.paused=${gate.paused}`);
	gate.resume();
	await p;
});

test("same two holds as a barrier list: pause is honoured", async () => {
	const gate = new AgentPauseGate();
	setTimeout(() => gate.pause(), 10);
	let dispatched = false;
	const p = holdAllBeforeDispatch([gate.dispatchHold(), slowNext]).then(() => {
		dispatched = true;
	});
	await Bun.sleep(80);
	console.log(`barrier list:      dispatched=${dispatched} gate.paused=${gate.paused}`);
	gate.resume();
	await p;
	expect(true).toBe(true);
});
