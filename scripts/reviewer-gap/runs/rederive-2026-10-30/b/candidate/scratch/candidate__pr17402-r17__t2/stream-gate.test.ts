import { expect, test } from "bun:test";
import { clearCustomApis, getCustomApi, registerCustomApi } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/api-registry";
import { AssistantMessageEventStream } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/ai/src/utils/event-stream";
import { providerCallGate } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/callback-ownership";
import { ExtensionRuntime } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/9af7d8eb683da64b5888a996d7a4a28a912c94d7/packages/coding-agent/src/extensibility/extensions/loader";

test("gated custom stream is not counted and outlives retirement", async () => {
	const runtime = new ExtensionRuntime();
	const release = runtime.beginSession();
	const ticks: string[] = [];
	registerCustomApi(
		"probe-stream-api",
		() => {
			const s = new AssistantMessageEventStream();
			let n = 0;
			const t = setInterval(() => {
				ticks.push(`tick${++n} retired=${runtime.isRetired}`);
				if (n === 3) clearInterval(t);
			}, 20);
			return s;
		},
		"ext://s",
		undefined,
		providerCallGate(runtime),
	);
	getCustomApi("probe-stream-api")!.streamSimple({} as never, {} as never, {} as never);
	console.log("hasPendingCallbacks while stream live =", runtime.hasPendingCallbacks());
	const t0 = Date.now();
	await runtime.waitForPendingCallbacks();
	console.log("waitForPendingCallbacks resolved after ms =", Date.now() - t0);
	release();
	await Bun.sleep(100);
	console.log(ticks);
	clearCustomApis();
	expect(true).toBe(true);
});
