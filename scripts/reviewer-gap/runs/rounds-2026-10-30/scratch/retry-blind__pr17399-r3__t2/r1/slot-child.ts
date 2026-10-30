// Child process: a request held by a never-released dispatch hold (a /pause)
// with a provider in-flight limit of 1.
const H = "/mnt/nvme/sami/tmp/cachefix/reviewer-evals/heads/670df28f7bf7/packages/ai/src";
const { createMockModel, registerMockApi } = await import(`${H}/providers/mock`);
const { __providerInFlightForTesting, streamSimple } = await import(`${H}/stream`);

__providerInFlightForTesting.setRoot(process.env.LIMIT_ROOT!);
registerMockApi();
const mock = createMockModel({ provider: "tests", handler: async () => ({ content: ["child"] }) });
let held = 0;
streamSimple(mock.model, { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] }, {
	maxInFlightRequests: { tests: 1 },
	beforeDispatch: () => {
		held++;
		console.log("CHILD held (paused) at", Date.now());
		return new Promise<void>(() => {}); // /pause never released
	},
});
setInterval(() => {}, 1000);
