import { expect, it } from "bun:test";
import * as path from "node:path";
import { PYTHON_PRELUDE } from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/prelude";

const RUNNER = path.resolve(
	import.meta.dir,
	"../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/eval/py/runner.py",
);

it("a cell's pinned URL roots are the ones its own request delivered", async () => {
	const OLD = JSON.stringify({ artifact: "/sessions/OLD/artifacts", local: "/sessions/OLD/local" });
	const NEW = JSON.stringify({ artifact: "/sessions/NEW/artifacts", local: "/sessions/NEW/local" });
	const proc = Bun.spawn(["python3", RUNNER], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_EVAL_LOCAL_ROOTS: OLD },
	});
	const lines: string[] = [];
	const done = new Map<string, () => void>();
	const waiters = new Map<string, Promise<void>>();
	for (const id of ["prelude", "cell-new-session"]) {
		const { promise, resolve } = Promise.withResolvers<void>();
		done.set(id, resolve);
		waiters.set(id, promise);
	}
	(async () => {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of proc.stdout) {
			buf += dec.decode(chunk);
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				lines.push(line);
				try {
					const f = JSON.parse(line);
					if (f.type === "done") done.get(f.id)?.();
				} catch {}
			}
		}
	})();
	const send = (o: unknown) => {
		proc.stdin.write(`${JSON.stringify(o)}\n`);
		proc.stdin.flush();
	};
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_emit_status = __omp_emit_image = lambda *args, **kwargs: None",
	);
	send({ id: "prelude", code: prelude, silent: true });
	await waiters.get("prelude");
	// The host moves this kernel to a session whose artifacts live elsewhere and
	// delivers the new roots with the cell, as executor-base does on every run.
	send({
		id: "cell-new-session",
		code: "import os\nprint('PINNED', __omp_current_url_roots__())\nprint('ENV   ', os.environ['PI_EVAL_LOCAL_ROOTS'])\nprint('USED  ', _omp_url_roots().get('artifact'))",
		env: { PI_EVAL_LOCAL_ROOTS: NEW },
	});
	await waiters.get("cell-new-session");
	proc.stdin.end();
	proc.kill();
	const out = lines
		.map(l => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(f => f && f.id === "cell-new-session" && (f.type === "stream" || f.type === "stdout" || f.text))
		.map(f => f.text ?? f.data ?? JSON.stringify(f))
		.join("");
	console.log(out || lines.filter(l => l.includes("cell-new-session")).join("\n"));
	expect(out).toContain("USED   /sessions/NEW/artifacts");
}, 30_000);
