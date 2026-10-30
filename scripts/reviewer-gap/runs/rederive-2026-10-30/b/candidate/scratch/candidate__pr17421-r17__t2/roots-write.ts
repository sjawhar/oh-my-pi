import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PYTHON_PRELUDE } from "@oh-my-pi/pi-coding-agent/eval/py/prelude";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "roots-"));
const OLD = path.join(base, "OLD");
const NEW = path.join(base, "NEW");
for (const d of [OLD, NEW]) fs.mkdirSync(path.join(d, "local"), { recursive: true });
const roots = (d: string) => JSON.stringify({ artifact: d, local: path.join(d, "local") });
const runner = path.resolve(import.meta.dir, "node_modules/@oh-my-pi/pi-coding-agent/src/eval/py/runner.py");
const proc = Bun.spawn(["python3", runner], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "inherit",
	env: { ...process.env, PI_EVAL_LOCAL_ROOTS: undefined },
});
const send = (o: unknown) => proc.stdin.write(`${JSON.stringify(o)}\n`);
send({ id: "prelude", code: PYTHON_PRELUDE, silent: true, env: { PI_EVAL_LOCAL_ROOTS: roots(OLD) } });
await Bun.sleep(1500);
send({ id: "cell-old", code: "print('old session cell wrote', write('local://a.txt', 'old'))", env: { PI_EVAL_LOCAL_ROOTS: roots(OLD) } });
await Bun.sleep(800);
// Session re-adopted / switched: host now sends NEW roots.
send({ id: "cell-new", code: "print('new session cell wrote', write('local://b.txt', 'new'))", env: { PI_EVAL_LOCAL_ROOTS: roots(NEW) } });
await Bun.sleep(800);
proc.stdin.end();
const out = await new Response(proc.stdout).text();
for (const line of out.split("\n")) if (line.includes('"stdout"') || line.includes('"error"')) console.log(line);
console.log("OLD/local:", fs.readdirSync(path.join(OLD, "local")));
console.log("NEW/local:", fs.readdirSync(path.join(NEW, "local")));
proc.kill();
