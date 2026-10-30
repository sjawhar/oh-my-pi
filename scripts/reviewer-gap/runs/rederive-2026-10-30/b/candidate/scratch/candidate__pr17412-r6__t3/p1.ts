import { executeShell } from "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/f8cddb4da5997f858ead9f5a3ab81e690517e081/packages/natives/native/index.js";

async function run(command: string, timeoutMs: number) {
	const t0 = performance.now();
	let out = "";
	const r = await Promise.race([
		executeShell({ command, timeoutMs, cwd: process.argv[3] ?? "/tmp" }, (_e, c) => { out += c; }),
		new Promise(res => setTimeout(() => res("HUNG(js 8s)"), 8000)),
	]);
	console.log(JSON.stringify({ command: command.slice(0, 80), ms: Math.round(performance.now() - t0), r, out: out.slice(0, 300) }));
}

const cmds = JSON.parse(process.argv[2]);
for (const [c, t] of cmds) await run(c, t);
process.exit(0);
