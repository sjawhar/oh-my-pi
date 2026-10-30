import { test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/f8cddb4da5997f858ead9f5a3ab81e690517e081/packages/natives/native/index.js";

async function run(command: string, cwd: string) {
	let out = "";
	const r = await executeShell({ command, cwd, timeoutMs: 5000 }, (_e, c) => {
		out += c;
	});
	return { r, out };
}

test("fifo substitution in background external command", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fifo-"));
	const cases = [
		// foreground: control
		"rm -f f; mkfifo f; (sleep 0.3; echo data > f) & /bin/echo \"fg=[$(<f)]\"; wait",
		// background external command: params.defer_fifo_redirects = true
		"rm -f f; mkfifo f; (sleep 0.3; echo data > f) & /bin/echo \"bg=[$(<f)]\" & wait",
		// background with regular file, control
		"printf data > r; /bin/echo \"bgfile=[$(<r)]\" & wait",
	];
	for (const c of cases) {
		const { r, out } = await run(c, dir);
		console.log(JSON.stringify(c), "=>", JSON.stringify(out), JSON.stringify(r));
	}
});
