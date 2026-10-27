/**
 * The runnable remainder of a blocked bash command.
 *
 * The bash interceptor refuses the whole call: nothing runs, so the model has
 * to re-send the steps the rule did not name. This module builds that re-send
 * text from the same segments the interceptor matched, and returns nothing
 * whenever the remainder would mean something different from what the model
 * wrote. A remainder is only ever *offered* in the refusal; it is never run.
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
 * Commands that only prepare the shell for the steps around them. A remainder
 * made of nothing but these (a lone `cd`, say) costs a round trip and produces
 * no output, so it is not worth offering. They are also the context a blocked
 * step ran in (its directory, its variables), which the refusal names.
 */
const PREPARATION_ONLY: Record<string, true> = {
	".": true,
	":": true,
	alias: true,
	cd: true,
	export: true,
	popd: true,
	pushd: true,
	set: true,
	shopt: true,
	source: true,
	true: true,
	trap: true,
	ulimit: true,
	umask: true,
	unset: true,
};

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
 * Whether a segment turns errexit on: `set` with an `e` among any of its short
 * flags (`set -e`, `set -euo pipefail`, `set -x -e`) or `-o errexit`, before
 * `--` ends the options. Under errexit every `;` behaves like `&&`, so a step
 * dropped from under it would let the steps after it run where the written
 * command would have stopped.
 */
function setsErrexit(text: string): boolean {
	if (commandWord(text) !== "set") return false;
	const words = text.split(/\s+/);
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word === "--" || word === "-") return false;
		if (/^-[A-Za-z]*e[A-Za-z]*$/.test(word)) return true;
		if (word === "-o" && words[index + 1] === "errexit") return true;
	}
	return false;
}

/** An unquoted `>`/`>>`/`&>` target, or an argument of `tee`, written by the given text. */
const REDIRECT_TARGET = /(?:^|[\s;|&])(?:\d*>{1,2}\|?|&>{1,2})\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
const TEE_TARGETS =
	/(?:^|[\s|])tee\s+((?:-\S+\s+)*)((?:"[^"]*"|'[^']*'|[^\s;|&<>]+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s;|&<>]+))*)/g;

function unquote(word: string): string {
	const quote = word[0];
	return (quote === '"' || quote === "'") && word.endsWith(quote) ? word.slice(1, -1) : word;
}

/**
 * Paths the given command text writes, excluding shell device sinks. A target
 * that ends in a quote sits inside a string another shell runs
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
	return paths.filter(path => !path.startsWith("/dev/"));
}

/**
 * Whether a pipeline stage only filters its input: a stream filter whose shell
 * redirects write no file and which runs no command of its own (`sed -i`,
 * `sed …w file`, `sort -o`, `uniq in out`, or an `awk` program that
 * redirects, pipes or calls `system`). Quoted text is the filter's own
 * pattern or program, so a `>` there is a comparison, not a shell redirect.
 */
function isStreamFilter(text: string): boolean {
	const word = commandWord(text);
	if (!STREAM_FILTERS[word] || writtenPaths(text.replace(/'[^']*'|"[^"]*"/g, "''")).length > 0) return false;
	const args = text.split(/\s+/).slice(1);
	if (word === "sed") {
		return !args.some(arg => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place")) && !/[\s/;}][wW]\s/.test(text);
	}
	if (word === "sort") return !args.some(arg => /^-[A-Za-z]*o/.test(arg) || arg.startsWith("--output"));
	if (word === "uniq") return args.every(arg => arg.startsWith("-"));
	// Comparisons (`$1>=76`) are fine; output redirection and pipes hang off `print`/`printf`.
	if (word === "awk") return !/\bsystem\s*\(|\|\s*getline|\b(?:print|printf)\b[^;}]*[>|]/.test(text);
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
 * only prepare the shell (a `cd`, an `export`) are not counted; they are named
 * in `context` instead.
 */
export type BashRemainderPlace = "before" | "between" | "after";

/** One blocked step and every pipeline stage that went with it. */
export interface BashRemainderGroup {
	/** Index of the blocked segment that heads the group. */
	blockedIndex: number;
	/** The group's text as the caller wrote it. */
	text: string;
	place: BashRemainderPlace;
	/** Kept steps that only prepare the shell and ran before the group (its `cd`, its variables). */
	context: string[];
	/** The kept working step just before the group, when `&&` or `||` made the group depend on it. */
	condition?: { step: string; operator: "&&" | "||" };
}

/** The text the caller can re-send, and where each dropped group belongs around it. */
export interface BashRemainder {
	text: string;
	groups: BashRemainderGroup[];
}

/**
 * The text the caller can re-send after the interceptor refused the whole
 * call: `command` without every blocked step and the pipeline each one heads,
 * or `undefined` when that text would not mean what the caller wrote.
 *
 * Nothing is offered when a dropped step sits inside a compound command (`if`,
 * `for`, `while`, `case`), when a dropped pipeline stage does more than
 * filter its input, when a dropped step leaves shell state behind (a `cd`, a
 * bare assignment, a `set`, an `exec`), when a later step reads its exit
 * status, its last argument or its job, or a file it wrote, when dropping it
 * would make a `&&`/`||` chain's later command unconditional, when the command
 * sets errexit, when the rejoined text no longer parses into exactly the kept
 * steps, when the remainder would be refused in turn, or when a dropped group
 * sat between working steps and either does more than read or names a file one
 * of them writes (no single call then keeps the order the caller wrote).
 *
 * @param command The command the interceptor matched, with its original text.
 * @param segments Its segments, as the interceptor matched them.
 * @param blocked The segments a rule matches, ascending.
 * @param isBlocked Whether a candidate remainder would itself be refused.
 */
export function buildBashRemainder(
	command: string,
	segments: FlatShellCommandSegment[],
	blocked: BashBlockedStep[],
	isBlocked: (candidate: string) => boolean,
): BashRemainder | undefined {
	if (blocked.length === 0 || blocked.some(step => !segments[step.index])) return undefined;
	const inside = compoundMembers(segments);
	if (!inside) return undefined;
	// `;;` (or `& ;`) between two steps is a syntax error outside `case`, so
	// the written command never ran; a remainder without it would.
	const hasCase = segments.some(segment => /^case\s/.test(segment.text));
	for (let index = 1; index < segments.length && !hasCase; index++) {
		if (/;\s*;|(?<![&|])&\s*;/.test(command.slice(segments[index - 1].end, segments[index].start))) return undefined;
	}

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
		spans.push({ step, first, last });
	}
	const kept = segments.filter((_, index) => !drop.has(index));
	// A command word that is itself an assignment (`X=1`) sets a variable and runs nothing.
	const preparesOnly = (segment: FlatShellCommandSegment): boolean =>
		Boolean(PREPARATION_ONLY[commandWord(segment.text)]) || LEADING_ASSIGNMENT.test(commandWord(segment.text));
	if (kept.every(preparesOnly)) return undefined;
	const errexit = segments.some(segment => setsErrexit(segment.text));

	// Dropping a step must not change what the steps after it see.
	for (const index of drop) {
		const segment = segments[index];
		const later = segments.slice(index + 1).filter((_, offset) => !drop.has(index + 1 + offset));
		if (!drop.has(index + 1) && (segment.terminator === "&&" || segment.terminator === "||")) return undefined;
		if (later.length === 0) continue;
		if (errexit) return undefined;
		if (later.some(step => PREVIOUS_COMMAND.test(step.text))) return undefined;
		// `NAME=value cmd` sets NAME for `cmd` alone; only a bare `NAME=value` outlives its step.
		const word = commandWord(segment.text);
		if (LEADING_ASSIGNMENT.test(word) || STATEFUL_COMMANDS[word]) return undefined;
		const written = writtenPaths(segment.text);
		if (later.some(step => written.some(path => step.text.includes(path)))) return undefined;
	}

	// Rejoin the kept steps with the operator that separated them. Where a
	// dropped step sat between two kept ones, the operator before it goes too:
	// only `;` (or the `&` that backgrounds the step before) still describes
	// what the kept steps do, and the `&&`/`||` case is already refused above.
	const lastKept = segments.reduce((last, _, index) => (drop.has(index) ? last : index), -1);
	const pieces: string[] = [];
	for (const [index, segment] of segments.entries()) {
		if (drop.has(index)) continue;
		pieces.push(segment.text);
		if (index === lastKept) {
			if (segment.terminator === "&") pieces.push(" &");
			continue;
		}
		const operator =
			drop.has(index + 1) && segment.terminator !== "&" && segment.terminator !== "\n" ? ";" : segment.terminator;
		pieces.push(operator === "\n" ? "\n" : operator === ";" ? "; " : ` ${operator} `);
	}
	const remainder = pieces.join("").trim();
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
	// caller has to know where each one goes and what it ran after.
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
		// the group must not depend on that order: it only reads, and no working
		// step writes a file it names.
		if (place === "between") {
			if (!step.readsOnly) return undefined;
			if (working.some(index => writtenPaths(segments[index].text).some(path => text.includes(path)))) {
				return undefined;
			}
		}
		const context = segments
			.slice(0, first)
			.filter((segment, index) => !drop.has(index) && preparesOnly(segment))
			.map(segment => segment.text);
		const previous = segments[first - 1];
		const condition =
			previous && working.includes(first - 1) && (previous.terminator === "&&" || previous.terminator === "||")
				? { step: previous.text, operator: previous.terminator }
				: undefined;
		groups.push({ blockedIndex: step.index, text, place, context, condition });
	}
	return { text: remainder, groups };
}
