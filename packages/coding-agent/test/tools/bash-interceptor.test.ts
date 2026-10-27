import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashInterceptorRule } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { bashShellStopsOnError, noteBashShellState } from "@oh-my-pi/pi-coding-agent/tools/bash-shell-state";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/exec/settings";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: Settings.isolated({
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": rules,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
		}),
		getSessionFile: () => null,
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		const command = "cd packages/coding-agent && cat package.json";
		await expect(
			tool.execute("tool-call", { command }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow(`Use read instead.\n\nOriginal command: ${command}`);
	});
});

describe("compound command interception", () => {
	const rules: BashInterceptorRule[] = [
		{
			pattern: "^\\s*git\\s+commit\\b",
			tool: "commit",
			message: "Use the commit tool instead.",
		},
	];

	it.each([
		"git commit -m message",
		"git add file && git commit -m message",
		"git add file; git commit -m message",
		"git add file || git commit -m message",
		"git add file & git commit -m message",
		"git add file\ngit commit -m message",
	])("blocks a later command after %s", command => {
		expect(checkBashInterception(command, ["commit"], rules).block).toBe(true);
	});

	it("does not intercept a downstream pipe stage that consumes piped stdin", () => {
		// `git commit` after a single `|` reads the previous stage's stdout, so
		// the dedicated tool cannot replace it. `||` still starts a fresh command.
		expect(checkBashInterception("git add file | git commit -m message", ["commit"], rules).block).toBe(false);
		expect(checkBashInterception("git add file || git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("removes one or more leading environment assignments before matching", () => {
		expect(
			checkBashInterception('GIT_AUTHOR_EMAIL="a@example.com" git commit -m message', ["commit"], rules).block,
		).toBe(true);
		expect(
			checkBashInterception(
				'GIT_AUTHOR_EMAIL="a@example.com" GIT_AUTHOR_NAME=Dev git commit -m message',
				["commit"],
				rules,
			).block,
		).toBe(true);
	});

	it("does not treat quoted, escaped, or commented text as a later command", () => {
		for (const command of [
			"printf '%s\\n' \"git add file && git commit -m message\"",
			'echo "git commit"',
			"echo git\\ commit",
			"echo ok # git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("does not treat redirection targets as later commands", () => {
		for (const command of [
			"echo hi >|git commit -m message",
			"echo hi >| git commit -m message",
			"echo hi >&git commit -m message",
			"echo hi >& git commit -m message",
			"echo hi <&3 git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
		// <& is a redirect operator, so the & does not split the command;
		// but when a && follows the redirect, the later command is still extracted.
		expect(checkBashInterception("echo hi <&3 && git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("does not add matches for unsupported shell syntax", () => {
		for (const command of [
			'echo "$(git commit -m message)"',
			"echo `git commit -m message`",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell parameter expansion under test
			"echo ${x:-foo;git commit -m message}",
			"( git commit -m message )",
			"echo start; { true; git commit -m message; }",
			"cat <<'EOF'\ngit commit -m message\nEOF",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("keeps matching a rule written for the complete original input", () => {
		const command = "git add file && git commit -m message";
		const completeInputRule: BashInterceptorRule[] = [
			{
				pattern: "^git add file && git commit",
				tool: "commit",
				message: "Use the commit tool instead.",
			},
		];
		expect(checkBashInterception(command, ["commit"], completeInputRule).block).toBe(true);
	});

	it("does not block when the suggested tool is unavailable", () => {
		expect(checkBashInterception("git add file && git commit -m message", [], rules).block).toBe(false);
	});
});

describe("default echo/printf redirect rule", () => {
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("does not attribute a later command's stderr redirect to echo", () => {
		const tools = ["write", "read"];
		for (const command of [
			'echo "hi"; gcloud auth print-access-token 2>/tmp/tok.err',
			'echo "hi" && ls 2>/tmp/e.err',
			"echo start\nmake 2>build.err",
			"echo x > /dev/null; ls > listing.txt",
			"echo x 2>err.log",
			"echo x 2>>err.log",
			"echo x 2>&1 && ls > listing.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		expect(checkBashInterception("ls; echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi 1> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi &> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		for (const command of ["echo hi 2>err.txt > out.txt", "echo hi 2>|err.txt > out.txt", "echo hi 2>&1 > out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		}
	});

	it("keeps scanning past escaped separators and input fd duplication", () => {
		const tools = ["write", "read"];
		for (const command of [
			"echo foo\\; > out.txt",
			"echo a \\| b > out.txt",
			"echo a \\& b > out.txt",
			"echo hi <&0 > out.txt",
			"echo hi 0<&- > out.txt",
			"echo one\\\ntwo > out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("echo hi <&0", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("keeps separators inside a substitution out of the boundary scan", () => {
		const tools = ["write", "read"];
		for (const command of [
			"echo $(printf foo; printf bar) > out.txt",
			"echo `date; ls` > out.txt",
			"echo ${x:-a;b} > out.txt",
			"echo $(ls > /dev/null) > out.txt",
			"echo ${a:-${b}} > out.txt",
			"echo $(( (1 + 2) * 3 )) > out.txt",
			"printf %s ${HOME:-${USER}} >> out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("echo $(ls) ; ls > f", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo ${a:-${b}}; ls 2>e.log", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception("echo $(printf a; printf b)", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
	});

	it("matches commands with many stderr sinks without exponential backtracking", () => {
		const start = performance.now();
		const echo = checkBashInterception(
			"echo hi" + " 2>/dev/null 2>>/dev/null 2>&1 \\; <&0 $(a; b) `c; d` ${e:-f;g}".repeat(20),
			["write"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		const cat = checkBashInterception(
			`cat${" 2>>/dev/null 2>|e.log".repeat(20)} file.txt`,
			["write", "read"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(echo.block).toBe(false);
		expect(cat.suggestedTool).toBe("read");
	});

	it("routes cat heredoc and redirect writes to write, not read", () => {
		const tools = ["write", "read"];
		for (const command of ["cat > /tmp/f <<'EOF'\nx\nEOF", "cat <<'EOF' > /tmp/f\nx\nEOF", "cat >> log.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("cat <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("cat file.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
	});

	it("keeps cat on read unless its stdout goes to a file", () => {
		const tools = ["write", "read"];
		for (const command of [
			"cat 2>/dev/null file.txt",
			"cat 2>err.log file.txt",
			"cat 2>&1 file.txt",
			"cat >&2 file.txt",
			"cat 1>&2 file.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
		}
		for (const command of [
			"cat 2>err.log > out.txt",
			"cat 2> err.log >> out.txt",
			"cat 2>/dev/null 1>out.txt",
			"cat &>out.txt",
			"cat 2>&1 1>out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(
			checkBashInterception("cat 2>/dev/null <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
	});
});

describe("default grep rule and pipeline stdin", () => {
	const tools = ["grep"];

	it("blocks standalone file searches", () => {
		expect(checkBashInterception("grep pattern path", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("rg pattern src", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks a first-stage grep that produces pipeline input", () => {
		expect(checkBashInterception("grep x file | wc -l", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block grep consuming pipeline stdin", () => {
		expect(checkBashInterception("printf 'x\\n' | grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(
			checkBashInterception("tr -d '\\r' < input.log | grep -v '^ *foo'", tools, DEFAULT_BASH_INTERCEPTOR_RULES)
				.block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(
			checkBashInterception("printf 'x\\n' |\n # filter\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |& grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks a standalone grep sequenced after a pipeline", () => {
		expect(
			checkBashInterception("cat log | tr a b && grep err file", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});
});

describe("default bash service rules", () => {
	const tools = ["bash"];

	it.each(["bun run dev", "vite --host 0.0.0.0", "lldb ./app", "bun test --watch", "nohup server", "server &"])(
		"routes %s to named bash service mode",
		command => {
			const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(result.block).toBe(true);
			expect(result.suggestedTool).toBe("bash");
		},
	);

	it.each(["git diff -w", "docker compose up -d", "bun test", "printf 'server &'"])(
		"does not misclassify finite command %s",
		command => {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		},
	);
});

describe("the refused call's runnable remainder", () => {
	const tools = ["read", "grep", "glob", "edit", "write", "bash"];
	const remainderOf = (command: string): string | undefined =>
		checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).remainder;
	const offerOf = (command: string, availableTools = tools): string =>
		(checkBashInterception(command, availableTools, DEFAULT_BASH_INTERCEPTOR_RULES).message ?? "").split(
			"\n\nNothing ran. ",
		)[1] ?? "";

	it.each([
		["a sequenced step", "head -c 20 notes.md; echo; ls out*", "echo; ls out*"],
		["the last step", "make build; cat log.txt", "make build"],
		["a step on its own line", "make build\ncat log.txt\necho done", "make build\necho done"],
		["every blocked step at once", "ls src; cat a.txt; echo mid; grep -n x b.txt", "ls src; echo mid"],
		["the pipeline of filters a blocked step feeds", "ls src; cat a.txt | wc -l; echo done", "ls src; echo done"],
		["a blocked step's own environment prefix", "LC_ALL=C grep -n x a.txt; ls", "ls"],
		["the plain cd a blocked step ran in", "cd /srv; cat log.txt; ls", "cd /srv; ls"],
		["a sourced file the blocked step followed", "source ./env.sh; cat log.txt", "source ./env.sh"],
		[
			"a loop the blocked step follows",
			'for f in a b; do echo "$f"; done; cat log.txt',
			'for f in a b; do echo "$f"; done',
		],
		[
			"an awk filter that only compares",
			"ls src; grep -n x a.txt | awk -F: '$1>=76'; echo done",
			"ls src; echo done",
		],
		[
			"the operators between two kept steps, unchanged",
			"x=b; [[ $x =~ a|b ]] && echo hit; cat f.txt; echo done",
			"x=b; [[ $x =~ a|b ]] && echo hit; echo done",
		],
	])("keeps %s", (_case, command, expected) => {
		expect(remainderOf(command)).toBe(expected);
	});

	it.each([
		["a later command would become unconditional", "cat log.txt && rm log.txt"],
		["the blocked step is the fallback of an earlier one", "make || cat log.txt"],
		["a kept step follows the blocked one by `&&`", "cat log.txt && make; ls"],
		["a kept step is the blocked one's fallback", "cat log.txt || make; ls"],
		["an earlier kept step reaches the blocked one by `&&`", "cd /srv && cat log.txt; ls"],
		["the blocked step is backgrounded", "cat log.txt & ls"],
		["a backgrounded neighbour would move to the foreground", "make build & cat log.txt; echo done"],
		["a backgrounded chain would move to the foreground", "make && grep -n error build.log & make test"],
		["a later step reads the exit status", "cat log.txt; rc=$?; echo $rc"],
		["a later step reads a pipeline's exit status", "cat log.txt; echo $PIPESTATUS"],
		["a later step reads the blocked step's last argument", "cat a.txt; wc -l $_"],
		["a later step names a job", "tail -20 a.log; make & sleep 5; kill %1"],
		["errexit would have stopped the call at the blocked step", "set -e; grep -q TODO notes.txt; rm -rf build"],
		["errexit is set in the long spelling", "set -o errexit; cat marker; git push origin main"],
		["errexit is set among other flags", "set -euo pipefail; cat marker; rm -rf out"],
		["errexit is set in a later flag word", "set -x -e; cat marker; rm -rf out"],
		["errexit is set through shopt", "shopt -s -o errexit; cat marker; rm -rf out"],
		["an ERR trap would have stopped the call", "trap 'exit 1' ERR; cat marker; rm -rf out"],
		["a sourced file could have set errexit", "source ./env.sh; cat marker; rm -rf out"],
		["a later step reads a file the blocked step wrote", "echo hi > out.txt; wc -l out.txt"],
		["a later step reads that file without its leading `./`", "echo hi > ./out.txt; wc -l out.txt"],
		["a later step reads a file the blocked step wrote without spacing", "grep x a.txt>hits.txt; wc -l hits.txt"],
		["the blocked step deletes every match", "find . -name '*.pyc' -delete; git status --short"],
		["the blocked step runs a command per match", "find . -name __pycache__ -exec rm -rf {} + ; ls"],
		["a dropped pipeline stage runs a command of its own", "cat files.txt | xargs rm -f; ls"],
		["a dropped pipeline stage writes a file", "cat a.txt | sort -o sorted.txt; wc -l sorted.txt"],
		["a dropped pipeline stage edits in place", "grep -l TODO src/*.ts | xargs sed -i 's/TODO/DONE/'; git diff"],
		["a dropped sed stage writes its own file", "cat a.txt | sed -n '1,5w out.txt'; wc -l out.txt"],
		["a dropped awk stage reads its program from a file", "cat a.txt | awk -f prog.awk; ls"],
		["a dropped awk stage writes a file", "cat a.txt | awk '{print $1 > \"ids.txt\"}'; ls"],
		["the blocked step sits in a loop body", 'for f in a b; do echo "== $f"; grep -n foo "$f"; done'],
		["the blocked step sits in an if body", "if [ -f x ]; then\n  cat x\nfi\necho done"],
		["the command cannot be split", "cat $(ls); ls"],
		["the written command is a syntax error", "cat a ;; ls"],
		["the written command ends in a dangling operator", "cat a.txt; make &&"],
		["the blocked step is the whole command", "cat log.txt"],
		["what is left only prepares the shell", "cd /srv; cat log.txt"],
		["what is left only assigns a path", "X=/a/b; cat f.txt"],
		["what is left would be refused in turn", "cat a.txt; sleep 9 &"],
		["the directory the blocked step ran in is not one plain cd", "cd /srv; cd lib; cat log.txt; ls"],
		["the directory the blocked step ran in came from an alternative", "cd /a || cd /b; cat log.txt; ls"],
		["the directory the blocked step ran in is the one before it", "cd -; cat log.txt; ls"],
		["the directory the blocked step ran in is computed", 'cd "$HOME/src"; cat log.txt; ls'],
		["a sourced file ran before the blocked step", ". ./gen.sh > out.txt; cat out.txt; ls"],
		[
			"a blocked step between kept ones reads a file an earlier one wrote",
			"make > build.log; grep -n error build.log; echo done",
		],
		[
			"the earlier kept step writes that file from a nested shell",
			"sh -c 'make > build.log'; grep -n error build.log; echo done",
		],
		["the earlier kept step writes that file through tee", "make 2>&1 | tee build.log; grep -n error build.log; ls"],
		["a blocked step between kept ones reads a file a later one overwrites", "ls; cat log; make > log"],
		["a blocked step between kept ones edits a file", "make clean; sed -i 's/x/y/' config.h; make"],
		["a blocked step between kept ones writes a file", "ls; echo 1 > cfg.txt; make"],
	])("offers nothing when %s", (_case, command) => {
		expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(remainderOf(command)).toBeUndefined();
	});

	it("offers nothing when an earlier call left the session's shell stopping on the first error", () => {
		const command = "cat marker; rm -rf out";
		expect(remainderOf(command)).toBe("rm -rf out");
		const stopped = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES, command, {
			stopsOnError: true,
		});
		expect(stopped.block).toBe(true);
		expect(stopped.remainder).toBeUndefined();
		expect(stopped.message).not.toContain("Nothing ran.");
	});

	it("carries a session shell's errexit from the call that set it to the next check", () => {
		const sessionId = `bash-shell-state-${crypto.randomUUID()}`;
		expect(bashShellStopsOnError(sessionId)).toBe(false);
		noteBashShellState(sessionId, "echo plain; ls");
		expect(bashShellStopsOnError(sessionId)).toBe(false);
		noteBashShellState(sessionId, "set -euo pipefail; make");
		expect(bashShellStopsOnError(sessionId)).toBe(true);
	});

	it("offers nothing when a dropped step changes the shell's directory", () => {
		const navigation = [{ pattern: "^\\s*cd\\s+", tool: "bash", message: "Use the tool's cwd parameter." }];
		const result = checkBashInterception("cd /srv; ls; echo done", ["bash"], navigation);
		expect(result.block).toBe(true);
		expect(result.remainder).toBeUndefined();
	});

	it("offers nothing when a dropped step sets a variable the kept steps inherit", () => {
		const exports = [{ pattern: "^\\s*export\\s", tool: "bash", message: "Set it in the call's env instead." }];
		const result = checkBashInterception("export A=1; ls; echo done", ["bash"], exports);
		expect(result.block).toBe(true);
		expect(result.remainder).toBeUndefined();
	});

	it("offers nothing when the remainder would be refused once its leading cd is stripped", () => {
		const rules = [
			{ pattern: "^\\s*cat\\s", tool: "read", message: "Use read." },
			{ pattern: "^make && rm", tool: "bash", message: "No cleanup chains." },
		];
		expect(checkBashInterception("cd /srv && make && rm -f out", ["read", "bash"], rules).block).toBe(false);
		const result = checkBashInterception("cat a.txt; cd /srv && make && rm -f out", ["read", "bash"], rules);
		expect(result.block).toBe(true);
		expect(result.remainder).toBeUndefined();
	});

	it("offers nothing when the caller checks a form other than the one it was sent", () => {
		const result = checkBashInterception(
			"cat a.txt; ls",
			tools,
			DEFAULT_BASH_INTERCEPTOR_RULES,
			"cd /srv && cat a.txt; ls",
		);
		expect(result.block).toBe(true);
		expect(result.remainder).toBeUndefined();
	});

	it("keeps a trailing `&` when no rule refuses background syntax", () => {
		expect(offerOf("cat log.txt; make build &", ["read"])).toBe(
			"Use `read` for `cat log.txt`, then re-send the rest as one bash call:\nmake build &",
		);
	});

	it("says nothing about a remainder when there is none", () => {
		const result = checkBashInterception("cat log.txt && rm log.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.message).not.toContain("re-send");
		expect(result.message).toContain("Original command: cat log.txt && rm log.txt");
	});

	it.each([
		[
			"before the rest when it came first",
			"head -c 20 notes.md; echo; ls out*",
			"Use `read` for `head -c 20 notes.md`, then re-send the rest as one bash call:\necho; ls out*",
		],
		[
			"before the rest, after the cd it ran in",
			"cd /srv; cat log.txt; ls",
			"Use `read` for `cat log.txt` (it ran after `cd /srv`), then re-send the rest as one bash call:\ncd /srv; ls",
		],
		[
			"after the rest when it came last",
			"make build; cat log.txt",
			"Re-send the rest as one bash call, then use `read` for `cat log.txt`:\nmake build",
		],
		[
			"on both ends when the blocked steps came first and last",
			"cat a.txt; make; cat b.txt",
			"Use `read` for `cat a.txt`, then re-send the rest as one bash call, then use `read` for `cat b.txt`:\nmake",
		],
		[
			"between the rest's steps, with the filters it fed",
			"ls src; cat a.txt | wc -l; echo done",
			"Re-send the rest as one bash call; use `read` for `cat a.txt | wc -l` too, which the original ran between its steps:\nls src; echo done",
		],
		[
			"between and after the rest, each where it ran",
			"ls src; cat a.txt; echo mid; grep -n x b.txt",
			"Re-send the rest as one bash call, then use `grep` for `grep -n x b.txt`; use `read` for `cat a.txt` too, which the original ran between its steps:\nls src; echo mid",
		],
	])("places the blocked step %s", (_case, command, offer) => {
		expect(offerOf(command)).toBe(offer);
	});

	it("keeps the offer to one line when a blocked step spans lines", () => {
		expect(offerOf('grep -n "a\nb" notes.txt; ls')).toBe(
			'Use `grep` for `grep -n "a\\nb" notes.txt`, then re-send the rest as one bash call:\nls',
		);
	});

	it("leaves a call the rules allow untouched", () => {
		const result = checkBashInterception("ls src; echo done", tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.block).toBe(false);
		expect(result.remainder).toBeUndefined();
	});
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});
