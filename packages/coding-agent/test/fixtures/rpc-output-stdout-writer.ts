// Child for rpc-output.test.ts: writes JSONL frames through RpcOutputWriter on
// the real process.stdout, then reports on stderr whether a spool appeared and
// how much memory stayed retained. argv: <frames> <frameBytes> <budget> <paced>
import * as fs from "node:fs";
import * as os from "node:os";
import { RpcOutputWriter } from "../../src/modes/rpc/rpc-output";

const [frames, frameBytes, budget] = process.argv.slice(2, 5).map(Number);
const paced = process.argv[5] === "paced";
const writer = new RpcOutputWriter(
	process.stdout,
	error => {
		process.stderr.write(`${JSON.stringify({ failure: error.message })}\n`);
		process.exit(2);
	},
	budget,
);
const payload = "x".repeat(frameBytes);
Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
for (let i = 0; i < frames; i++) {
	writer.write([`${JSON.stringify({ i, payload })}\n`]);
	if (paced) await Bun.sleep(0);
}
const spooled = fs.readdirSync(os.tmpdir()).some(name => name.startsWith("omp-rpc-output-"));
Bun.gc(true);
const retainedBytes = process.memoryUsage().rss - rssBefore;
process.stderr.write(`${JSON.stringify({ spooled, retainedBytes })}\n`);
await writer.close();
