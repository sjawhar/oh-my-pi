import { expect, test } from "bun:test";
import { armPreResponseTimeout, preResponseGuard } from "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src/utils/idle-iterator";

test("enclosing guard with two concurrently held inner guards", async () => {
	const outer = armPreResponseTimeout(undefined, 100);
	const i1 = armPreResponseTimeout(outer.signal, 10_000);
	const i2 = armPreResponseTimeout(outer.signal, 10_000);
	preResponseGuard(i1.signal)!.suspend();
	preResponseGuard(i2.signal)!.suspend();
	// first request reaches the wire; second still parked on the hold
	preResponseGuard(i1.signal)!.resume();
	i1.clear();
	await Bun.sleep(250);
	console.log("outer aborted while i2 still held:", outer.signal!.aborted, String(outer.signal!.reason));
	expect(true).toBe(true);
});
