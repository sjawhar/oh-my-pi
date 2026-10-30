// Child process: role A = paused session holding a request; role B = another, unpaused process.
const HEAD = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages";
const { __providerInFlightForTesting, streamSimple } = await import(`${HEAD}/ai/src/stream.ts`);
const { createMockModel, registerMockApi } = await import(`${HEAD}/ai/src/providers/mock.ts`);
const { agentPauseGate } = await import(`${HEAD}/agent/src/pause.ts`);

const [role, root] = process.argv.slice(2);
__providerInFlightForTesting.setRoot(root);
registerMockApi();
const t0 = Date.now();
const mock = createMockModel({
	provider: "tests",
	handler: async () => {
		console.log(`${role} DISPATCHED at +${Date.now() - t0}ms`);
		return { content: ["ok"] };
	},
});
const ctx = { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };

if (role === "A") {
	agentPauseGate.pause(); // `/pause` engaged in this process
	const s = streamSimple(mock.model, ctx, {
		maxInFlightRequests: { tests: 1 },
		beforeDispatch: agentPauseGate.dispatchHold(),
	});
	void s.result();
	await Bun.sleep(300);
	console.log(`A paused; lease dir entries: ${JSON.stringify(await Array.fromAsync(new Bun.Glob("**").scan({ cwd: root, onlyFiles: false })))}`);
	await Bun.sleep(60_000);
} else {
	const s = streamSimple(mock.model, ctx, { maxInFlightRequests: { tests: 1 } });
	const r = await Promise.race([s.result().then(() => "done"), Bun.sleep(5000).then(() => "STILL WAITING after 5000ms")]);
	console.log(`B result: ${r} (+${Date.now() - t0}ms)`);
	process.exit(0);
}
