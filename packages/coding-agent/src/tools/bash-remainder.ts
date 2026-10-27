/**
 * The runnable remainder of a blocked bash command.
 *
 * The bash interceptor refuses the whole call: nothing runs, so the model has
 * to re-send the steps the rule did not name. This module builds that re-send
 * text from the same segments the interceptor matched.
 *
 * It withholds by default. A remainder is offered only where the shell's
 * semantics are plainly safe: every dropped step is separated from the steps
 * around it by `;` or a newline (or is a stage of a pipeline whose other
 * stages only filter their input), and nothing a kept step does depends on a
 * dropped one. Anything else — a `&&`, `||` or `&` next to a dropped step, a
 * dropped step that leaves shell state behind or writes a file a kept step
 * names, a shell that stops on the first error — is silence. A wrong
 * remainder is worse than none, and a remainder is only ever *offered* in the
 * refusal; it is never run.
 */
import {
	extractFlatShellCommandSegments,
	extractLeadingCdTarget,
	type FlatShellCommandSegment,
} from "./shell-tokenize";

/**
 * Commands whose effect the following segments inherit: a directory change, a
 * shell option, an environment or function definition, a sourced file, or an
 * `exec` that replaces the shell or redirects its descriptors. If
 * the blocked group contains one, later steps would run in a different shell
 * state than the model wrote, so no remainder is offered.
 */
const STATEFUL_COMMANDS: Record<string, true> = {
	".": true,
	alias: true,
	cd: true,
	declare: true,
	eval: true,
	exec: true,
	export: true,
	popd: true,
	pushd: true,
	readonly: true,
	set: true,
	shopt: true,
	source: true,
	trap: true,
	typeset: true,
	ulimit: true,
	umask: true,
	unalias: true,
	unset: true,
};

/**
 * Commands that only prepare the shell for the steps around them and run no
 * work of their own. A remainder made of nothing but these (a lone `cd`, say)
 * costs a round trip and produces no output, so it is not worth offering, and
 * a dropped group that sits among them did not run between two steps that do
 * work. `source` and `.` are absent on purpose: they run a file nobody here
 * can read, which is work.
 */
const PREPARATION_ONLY: Record<string, true> = {
	":": true,
	alias: true,
	cd: true,
	export: true,
	popd: true,
	pushd: true,
	set: true,
	shopt: true,
	true: true,
	trap: true,
	ulimit: true,
	umask: true,
	unset: true,
};

/** Commands that move the shell between directories, so the steps after them run somewhere else. */
const DIRECTORY_COMMANDS: Record<string, true> = { cd: true, popd: true, pushd: true };

/**
 * A `cd` to one plain literal path: the only context the refusal names. Shell
 * expansion, a second word, an operator or `cd -` (the directory before this
 * one, which nothing here knows) would make the directory something this
 * module cannot state, and `cd a || cd b` is two segments, never one sequence
 * the dropped step ran after.
 */
const PLAIN_CD = /^cd\s+(?!-{1,2}$)("[^"$`'\\]*"|'[^']*'|[^\s;|&<>$`"'\\]+)$/;

/**
 * The words that open and close a compound command (`if … fi`,
 * `for … do … done`, `case … esac`), and the ones that continue it. The flat
 * segments do not see that structure, so a step dropped from inside one breaks
 * the syntax, or leaves a step that reads the loop variable outside its loop.
 */
const COMPOUND_OPENERS: Record<string, true> = {
	"{": true,
	case: true,
	coproc: true,
	for: true,
	function: true,
	if: true,
	select: true,
	until: true,
	while: true,
};
const COMPOUND_CLOSERS: Record<string, true> = { "}": true, done: true, esac: true, fi: true };
const COMPOUND_CONTINUATION = /^(?:do|elif|else|then)$/;

/**
 * For each segment, whether it belongs to a compound command: its opener, its
 * body, or its closer. `undefined` when the openers and closers do not
 * balance, so the structure cannot be read.
 */
function compoundMembers(segments: FlatShellCommandSegment[]): boolean[] | undefined {
	const inside: boolean[] = [];
	let depth = 0;
	for (const segment of segments) {
		const word = /^\S+/.exec(segment.text)?.[0] ?? "";
		if (COMPOUND_OPENERS[word]) depth++;
		inside.push(depth > 0 || COMPOUND_CONTINUATION.test(word));
		if (COMPOUND_CLOSERS[word] && --depth < 0) return undefined;
	}
	return depth === 0 ? inside : undefined;
}

/**
 * Commands that only transform the stream they read. A pipeline stage made of
 * one can go with the blocked step it follows, because the dedicated tool's
 * output stands in for both. Any other stage (`xargs rm`, `tee`, `sh`, `ssh`)
 * does work of its own that dropping it would lose.
 */
const STREAM_FILTERS: Record<string, true> = {
	awk: true,
	base64: true,
	cat: true,
	cmp: true,
	column: true,
	comm: true,
	cut: true,
	diff: true,
	egrep: true,
	expand: true,
	fgrep: true,
	fmt: true,
	fold: true,
	grep: true,
	head: true,
	jq: true,
	less: true,
	md5sum: true,
	more: true,
	nl: true,
	od: true,
	paste: true,
	rev: true,
	rg: true,
	sed: true,
	sha1sum: true,
	sha256sum: true,
	sort: true,
	strings: true,
	tac: true,
	tail: true,
	tr: true,
	uniq: true,
	wc: true,
	xxd: true,
};

/**
 * What a step reads from the one before it: its exit status (`$?`,
 * `$PIPESTATUS`), its last argument (`$_`) or the job it started (`$!`).
 */
const PREVIOUS_COMMAND = /\$\?|\$\{\?\}|\$\{?PIPESTATUS|\$_(?![A-Za-z0-9_])|\$\{_\}|\$!|\$\{!\}/;

/** What a step says about the jobs the ones before it started (`kill %1`, `fg`, `wait %2`). */
const JOB_CONTROL = /(?:^|[\s;|&])(?:fg|bg|disown|wait|kill|jobs)\b|%[0-9%+-]/;

/** A leading `NAME=value` word, which sets a variable the following segments can read. */
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The first word of a segment, after any leading `NAME=value` assignments. */
function commandWord(text: string): string {
	let rest = text;
	while (true) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S)*)\s+/.exec(rest);
		if (!match) break;
		rest = rest.slice(match[0].length);
	}
	const word = /^([^\s;|&<>]+)/.exec(rest)?.[1];
	if (!word) return "";
	// A bare assignment is a word of its own, and its value may hold a `/`.
	if (LEADING_ASSIGNMENT.test(word)) return word;
	return word.split("/").pop() ?? word;
}

/**
 * Whether a segment makes the shell stop at the first failing command: `set`
 * with an `e` among any of its short flags (`set -e`, `set -euo pipefail`,
 * `set -x -e`) or `-o errexit`, the same through `shopt -s -o errexit`, or an
 * `ERR` trap. Under any of them every `;` behaves like `&&`, so a step dropped
 * from under it would let the steps after it run where the written command
 * would have stopped. A `source`, `.` or `eval` runs text this module cannot
 * read, so it counts too.
 */
function enablesErrexit(text: string): boolean {
	const word = commandWord(text);
	if (word === "source" || word === "." || word === "eval") return true;
	if (word === "trap") return /\bERR\b/.test(text);
	if (word !== "set" && word !== "shopt") return false;
	const words = text.split(/\s+/);
	for (let index = 1; index < words.length; index++) {
		const option = words[index];
		if (option === "--" || option === "-") return false;
		if (word === "set" && /^-[A-Za-z]*e[A-Za-z]*$/.test(option)) return true;
		if (/^-[A-Za-z]*o$/.test(option) && words[index + 1] === "errexit") return true;
		if (/^-[A-Za-z]*o[A-Za-z]+$/.test(option) && option.endsWith("errexit")) return true;
	}
	return false;
}

/** The same spellings in text this module could not split into segments. */
const ERREXIT_TEXT =
	/(?:^|[\s;&|(])set\s+-[A-Za-z]*e|[-\s]o\s+errexit|\btrap\b[^;\n]*\bERR\b|\b(?:source|eval)\b|^\.\s/;

/**
 * Whether running `command` could leave the shell stopping on the first error.
 * The session's foreground calls share one persistent shell, so a `set -e` in
 * one call is still in force in the next, where a remainder built without it
 * would run steps the written command would have skipped. Text this module
 * cannot split is matched loosely rather than assumed harmless.
 */
export function commandEnablesErrexit(command: string): boolean {
	const segments = extractFlatShellCommandSegments(command);
	if (segments.length === 0) return ERREXIT_TEXT.test(command);
	return segments.some(segment => enablesErrexit(segment.text));
}

/** An unquoted `>`/`>>`/`&>` target, or an argument of `tee`, written by the given text. */
const REDIRECT_TARGET = /(?:\d*>{1,2}\|?|&>{1,2})\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
const TEE_TARGETS =
	/(?:^|[\s|])tee\s+((?:-\S+\s+)*)((?:"[^"]*"|'[^']*'|[^\s;|&<>]+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s;|&<>]+))*)/g;

/** Editors that rewrite their file operands in place rather than their stream. */
const IN_PLACE_EDITORS: Record<string, true> = { perl: true, ruby: true, sed: true };
const IN_PLACE_FLAG = /^-[A-Za-z]*i/;

/**
 * The device files a write leaves nothing behind in. Everything else under
 * `/dev` is an ordinary file: `/dev/shm/build.log` is read back like any
 * other path.
 */
const DEVICE_SINKS = /^\/dev\/(?:null|zero|full|random|urandom|tty|console|std(?:in|out|err)|fd\/\d+)$/;

function unquote(word: string): string {
	const quote = word[0];
	return (quote === '"' || quote === "'") && word.endsWith(quote) ? word.slice(1, -1) : word;
}

/**
 * Paths the given command text writes, excluding shell device sinks: its
 * redirect targets, its `tee` operands, and the file operands of an in-place
 * edit. A target that ends in a quote sits inside a string another shell runs
 * (`sh -c 'make > build.log'`); that shell still writes it, so the quote is
 * dropped from the path.
 */
function writtenPaths(text: string): string[] {
	const paths: string[] = [];
	for (const match of text.matchAll(REDIRECT_TARGET)) {
		const target = unquote(match[1] ?? "").replace(/["']+$/, "");
		if (target.length > 0) paths.push(target);
	}
	for (const match of text.matchAll(TEE_TARGETS)) {
		for (const word of (match[2] ?? "").split(/\s+/)) {
			const target = unquote(word).replace(/["']+$/, "");
			if (target.length > 0) paths.push(target);
		}
	}
	const words = text.split(/\s+/);
	if (IN_PLACE_EDITORS[commandWord(text)] && words.some(word => IN_PLACE_FLAG.test(word))) {
		// Everything after the script that is not an option is a file it rewrites.
		let seenScript = false;
		for (const word of words.slice(1)) {
			if (word.startsWith("-")) continue;
			if (!seenScript) {
				seenScript = true;
				continue;
			}
			paths.push(unquote(word));
		}
	}
	return paths.filter(path => !DEVICE_SINKS.test(path));
}

/**
 * Whether any of the given steps names a file one of `paths` is written to.
 * A path is matched by its bare file name too, so `./out.txt` written and
 * `out.txt` read are the same file.
 */
function namesWrittenPath(paths: string[], steps: FlatShellCommandSegment[]): boolean {
	return paths.some(path => {
		const base = path.split("/").filter(Boolean).pop();
		const names = base && base !== path ? [path, base] : [path];
		return names.some(name => steps.some(step => step.text.includes(name)));
	});
}

/**
 * Files a step names, whoever writes them: its operands, without its options
 * or its command word, kept only when a `/` or a file extension makes the word
 * a path rather than a pattern (`grep -n error build.log` names `build.log`,
 * not `error`).
 */
function pathWords(text: string): string[] {
	const words: string[] = [];
	let seenCommand = false;
	for (const word of text.split(/\s+/)) {
		if (LEADING_ASSIGNMENT.test(word)) continue;
		if (!seenCommand) {
			seenCommand = true;
			continue;
		}
		if (word.startsWith("-")) continue;
		const bare = unquote(word).replace(/["']+$/, "");
		if (!bare.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(bare)) continue;
		if (DEVICE_SINKS.test(bare)) continue;
		words.push(bare);
	}
	return words;
}

/**
 * Every operand a step names, without its command word, its leading
 * assignments and its option flags. Unlike {@link pathWords} this keeps a bare
 * word (`notes`, `Makefile`): two steps naming the same one share a file
 * whatever it looks like.
 */
const OPTION_FLAG = /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/;
function operandWords(text: string): string[] {
	const words: string[] = [];
	let seenCommand = false;
	for (const word of text.split(/\s+/)) {
		if (LEADING_ASSIGNMENT.test(word)) continue;
		if (!seenCommand) {
			seenCommand = true;
			continue;
		}
		if (word === "--" || OPTION_FLAG.test(word)) continue;
		const bare = unquote(word).replace(/["']+$/, "");
		if (bare.length > 0 && !DEVICE_SINKS.test(bare)) words.push(bare);
	}
	return words;
}

/**
 * Whether a step acts on a tree of files the refusal's tool cannot act on: a
 * `find`/`fd` that deletes or runs a command per hit. The line would offer
 * `glob`, which only lists.
 */
const FIND_ACTIONS = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprintf?)(?=\s|$)/;
const FD_ACTIONS = /(?:^|\s)(?:-x|-X|--exec|--exec-batch)(?=[\s=]|$)/;
function actsOnEveryMatch(text: string): boolean {
	const word = commandWord(text);
	if (word === "find") return FIND_ACTIONS.test(text);
	if (word === "fd" || word === "fdfind") return FD_ACTIONS.test(text);
	return false;
}

/**
 * Whether a pipeline stage only filters its input: a stream filter whose shell
 * redirects write no file and which runs no command of its own (`sed -i`,
 * `sed …w file`, `sort -o`, `uniq in out`, `xxd in out`, an `awk` program read
 * from a file or one that redirects, pipes or calls `system`). Quoted text is
 * the filter's own pattern or program, so a `>` there is a comparison, not a
 * shell redirect.
 */
function isStreamFilter(text: string): boolean {
	const word = commandWord(text);
	if (!STREAM_FILTERS[word] || writtenPaths(text.replace(/'[^']*'|"[^"]*"/g, "''")).length > 0) return false;
	const args = text.split(/\s+/).slice(1);
	if (word === "sed") {
		// A `w`/`W` command inside the script writes its file operand.
		return !args.some(arg => IN_PLACE_FLAG.test(arg)) && !/['"/0-9,;}\s][wW]\s+[^\s;|&]/.test(text);
	}
	if (word === "sort") return !args.some(arg => /^-[A-Za-z]*o/.test(arg) || arg.startsWith("--output"));
	// Their second operand is an output file; a lone `-` is stdin, not an option.
	if (word === "uniq" || word === "xxd") {
		return args.filter(arg => arg === "-" || !arg.startsWith("-")).length <= 1;
	}
	// Comparisons (`$1>=76`) are fine; output redirection and pipes hang off `print`/`printf`.
	if (word === "awk") {
		return (
			!args.some(arg => arg === "-f" || arg.startsWith("--file")) &&
			!/\bsystem\s*\(|\|\s*getline|\b(?:print|printf)\b[^;}]*[>|]/.test(text)
		);
	}
	return true;
}

/** A step a rule blocked, as the caller hands it in. */
export interface BashBlockedStep {
	/** Index of the blocked segment. */
	index: number;
	/** Whether the tool that replaces it only reads (`read`, `grep`, `glob`). */
	readsOnly: boolean;
}

/**
 * Where a dropped group ran relative to the remainder's steps that do work:
 * before all of them, after all of them, or between two of them. Steps that
 * only prepare the shell (a `cd`, an `export`) are not counted; the single
 * `cd` a group ran in is named in `context` instead.
 */
export type BashRemainderPlace = "before" | "between" | "after";

/** One blocked step and every pipeline stage that went with it. */
export interface BashRemainderGroup {
	/** Index of the blocked segment that heads the group. */
	blockedIndex: number;
	/** The group's text as the caller wrote it. */
	text: string;
	place: BashRemainderPlace;
	/** The plain `cd` the group ran in, when a kept step made one before it. */
	context?: string;
}

/** The text the caller can re-send, and where each dropped group belongs around it. */
export interface BashRemainder {
	text: string;
	groups: BashRemainderGroup[];
}

/** What an earlier call in the same session shell left behind. */
export interface BashShellState {
	/** The shell stops at the first failing command (`set -e`, `trap … ERR`) from an earlier call. */
	stopsOnError?: boolean;
}

/** Terminators that separate two top-level steps without making either depend on the other. */
function separatesPlainly(terminator: FlatShellCommandSegment["terminator"]): boolean {
	return terminator === ";" || terminator === "\n";
}

/**
 * Whether the text between two segments holds an operator the scanner did not
 * account for, which means the written command is not what the segments say it
 * is (`cat a ;; ls`, `cat a; make &&`). The gap carries the first segment's
 * terminator and nothing else but whitespace and comments.
 */
function gapIsClean(gap: string, terminator: string): boolean {
	const rest = (terminator.length > 0 ? gap.replace(terminator, "") : gap).split("#")[0] ?? "";
	return !/[;|&]/.test(rest);
}

/**
 * The text the caller can re-send after the interceptor refused the whole
 * call: `command` without every blocked step and the pipeline each one heads,
 * or `undefined` when that text would not plainly mean what the caller wrote.
 *
 * A remainder needs every dropped group to be separated from the steps around
 * it by `;` or a newline. A `&&`, `||` or `&` beside one is silence: dropping
 * a step out of a chain makes a conditional step unconditional, and `&`
 * backgrounds what came before it, which no re-send reproduces.
 *
 * Beyond that, nothing is offered when a dropped step sits inside a compound
 * command (`if`, `for`, `while`, `case`), when a dropped pipeline stage does
 * more than filter its input, when a dropped step leaves shell state behind (a
 * `cd`, a bare assignment, a `set`, an `exec`), when it deletes or runs
 * something per match (`find … -delete`), when a later step reads its exit
 * status, its last argument, its job or a file it wrote, when this call or an
 * earlier one in the same shell makes it stop on the first error, when the
 * written command does not parse into the segments it was matched as, when the
 * rejoined text no longer parses into exactly the kept steps, when the
 * remainder would be refused in turn, when a kept `cd` before a group leaves
 * the group's directory unstated, or when a dropped group sat between working
 * steps and either does more than read or names a file one of them writes (no
 * single call then keeps the order the caller wrote).
 *
 * @param command The command the interceptor matched, with its original text.
 * @param segments Its segments, as the interceptor matched them.
 * @param blocked The segments a rule matches, ascending.
 * @param isBlocked Whether a candidate remainder would itself be refused.
 * @param shell What an earlier call left in the shell this one would run in.
 */
export function buildBashRemainder(
	command: string,
	segments: FlatShellCommandSegment[],
	blocked: BashBlockedStep[],
	isBlocked: (candidate: string) => boolean,
	shell: BashShellState = {},
): BashRemainder | undefined {
	if (blocked.length === 0 || blocked.some(step => !segments[step.index])) return undefined;
	const inside = compoundMembers(segments);
	if (!inside) return undefined;
	// `case` lists its branches with `;;`, which the operator checks below read
	// as a syntax error; its branches are a compound body in any case.
	if (segments.some(segment => commandWord(segment.text) === "case")) return undefined;
	// An operator the segments do not carry means the written command is not the
	// list it was matched as — bash rejects `cat a ;; ls`, but a remainder of it
	// would run.
	if (/[;|&]/.test(command.slice(0, segments[0].start))) return undefined;
	for (let index = 1; index < segments.length; index++) {
		const previous = segments[index - 1];
		if (!gapIsClean(command.slice(previous.end, segments[index].start), previous.terminator)) return undefined;
	}
	const last = segments[segments.length - 1];
	if (last.terminator === "&&" || last.terminator === "||" || last.terminator === "|" || last.terminator === "|&") {
		return undefined;
	}
	if (!gapIsClean(command.slice(last.end), last.terminator)) return undefined;

	// A pipeline's stages share one stdin/stdout chain, so each blocked stage is
	// dropped together with every stage joined to it by `|` or `|&`. Only
	// stages that merely filter the stream can go unrun.
	const drop = new Set<number>();
	const spans: Array<{ step: BashBlockedStep; first: number; last: number }> = [];
	for (const step of blocked) {
		let first = step.index;
		while (first > 0 && segments[first].pipedStdin) first--;
		let last = step.index;
		while (last + 1 < segments.length && segments[last + 1].pipedStdin) last++;
		for (let index = first; index <= last; index++) {
			if (inside[index]) return undefined;
			if (index !== step.index && !isStreamFilter(segments[index].text)) return undefined;
			drop.add(index);
		}
		// Only `;` and a newline separate a group from its neighbours without
		// tying one to the other. `&&`/`||` make a kept step conditional on a
		// dropped one; `&` backgrounds everything up to it.
		if (!separatesPlainly(segments[last].terminator) && segments[last].terminator !== "") return undefined;
		if (first > 0 && !separatesPlainly(segments[first - 1].terminator)) return undefined;
		spans.push({ step, first, last });
	}
	const kept = segments.filter((_, index) => !drop.has(index));
	// A command word that is itself an assignment (`X=1`) sets a variable and
	// runs nothing — unless it writes a file on the way (`true > log.txt`).
	const preparesOnly = (segment: FlatShellCommandSegment): boolean =>
		(Boolean(PREPARATION_ONLY[commandWord(segment.text)]) || LEADING_ASSIGNMENT.test(commandWord(segment.text))) &&
		writtenPaths(segment.text).length === 0;
	if (kept.every(preparesOnly)) return undefined;
	const stopsOnError = Boolean(shell.stopsOnError) || segments.some(segment => enablesErrexit(segment.text));

	// Dropping a step must not change what the steps after it see.
	for (const index of drop) {
		const segment = segments[index];
		if (actsOnEveryMatch(segment.text)) return undefined;
		const later = segments.slice(index + 1).filter((_, offset) => !drop.has(index + 1 + offset));
		if (later.length === 0) continue;
		if (stopsOnError) return undefined;
		if (later.some(step => PREVIOUS_COMMAND.test(step.text) || JOB_CONTROL.test(step.text))) return undefined;
		// `NAME=value cmd` sets NAME for `cmd` alone; only a bare `NAME=value` outlives its step.
		const word = commandWord(segment.text);
		if (LEADING_ASSIGNMENT.test(word) || STATEFUL_COMMANDS[word]) return undefined;
		if (namesWrittenPath(writtenPaths(segment.text), later)) return undefined;
	}

	// Rejoin the runs of kept steps exactly as the caller wrote them, so the
	// operators inside a run keep their own spacing, and put back the `;` or
	// newline that separated a run from the dropped group after it.
	const runs: Array<{ first: number; last: number }> = [];
	for (let index = 0; index < segments.length; index++) {
		if (drop.has(index)) continue;
		const open = runs[runs.length - 1];
		if (open && open.last === index - 1) open.last = index;
		else runs.push({ first: index, last: index });
	}
	const pieces: string[] = [];
	for (const [position, run] of runs.entries()) {
		if (position > 0) pieces.push(segments[runs[position - 1].last].terminator === "\n" ? "\n" : "; ");
		pieces.push(command.slice(segments[run.first].start, segments[run.last].end));
	}
	const tail = segments[runs[runs.length - 1].last].terminator;
	const remainder = `${pieces.join("")}${tail === "&" ? " &" : ""}`.trim();
	if (remainder.length === 0 || remainder === command.trim()) return undefined;

	// The rejoined text must parse back into exactly the kept steps: anything
	// else means the scanner reads it differently than this rejoin assumed.
	const reparsed = extractFlatShellCommandSegments(remainder);
	const keptTexts = kept.map(segment => segment.text);
	const reparsedTexts = reparsed.length > 0 ? reparsed.map(segment => segment.text) : [remainder];
	if (reparsedTexts.length !== keptTexts.length || reparsedTexts.some((text, index) => text !== keptTexts[index])) {
		return undefined;
	}

	// The bash tool checks a command both as written and without its leading
	// `cd <path> &&`, so a remainder is only useful if neither form is refused.
	if (isBlocked(remainder)) return undefined;
	const leadingCd = extractLeadingCdTarget(remainder);
	if (leadingCd && isBlocked(leadingCd.rest)) return undefined;

	// The dropped groups are done with other tools, outside this call, so the
	// caller has to know where each one goes and which directory it ran in.
	const working = segments.flatMap((segment, index) => (drop.has(index) || preparesOnly(segment) ? [] : [index]));
	const groups: BashRemainderGroup[] = [];
	for (const { step, first, last } of spans) {
		const text = command.slice(segments[first].start, segments[last].end);
		const place: BashRemainderPlace = working.every(index => index > last)
			? "before"
			: working.every(index => index < first)
				? "after"
				: "between";
		// Between two working steps, one call cannot keep the written order, so
		// the group must not depend on that order: it only reads, and it shares
		// no file with a working step. Which of the two writes that file does not
		// matter — a kept `rm`, `cp`, `curl -o` or `mv` destroys or replaces what
		// the group was told to read, and the line puts the re-send first.
		if (place === "between") {
			if (!step.readsOnly) return undefined;
			const group = segments.slice(first, last + 1);
			const workingSteps = working.map(index => segments[index]);
			const groupFiles = group.flatMap(segment => pathWords(segment.text));
			if (namesWrittenPath(groupFiles, workingSteps)) return undefined;
			if (workingSteps.some(kept => namesWrittenPath(writtenPaths(kept.text), group))) return undefined;
			const groupOperands = new Set(group.flatMap(segment => operandWords(segment.text)));
			if (workingSteps.some(kept => operandWords(kept.text).some(word => groupOperands.has(word)))) {
				return undefined;
			}
		}
		// The group runs in whatever directory the kept steps before it left. Only
		// one plain `cd`, reached without a condition, states that directory.
		const changers = segments
			.slice(0, first)
			.filter((segment, index) => !drop.has(index) && DIRECTORY_COMMANDS[commandWord(segment.text)]);
		if (changers.length > 1) return undefined;
		const [changer] = changers;
		if (changer) {
			const index = segments.indexOf(changer);
			if (!PLAIN_CD.test(changer.text)) return undefined;
			if (!separatesPlainly(changer.terminator)) return undefined;
			if (index > 0 && !separatesPlainly(segments[index - 1].terminator)) return undefined;
		}
		groups.push({ blockedIndex: step.index, text, place, context: changer?.text });
	}
	return { text: remainder, groups };
}
