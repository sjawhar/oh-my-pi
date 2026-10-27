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
 * no output, so it is not worth offering.
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
	ulimit: true,
	umask: true,
	unset: true,
};

/** `$?`, `${?}` and `$PIPESTATUS` all read the exit status of what ran before. */
const EXIT_STATUS = /\$\?|\$\{\?\}|\$\{?PIPESTATUS/;

/**
 * `set -e` (in any flag spelling, or `set -o errexit`) makes every `;` behave
 * like `&&`: the shell leaves on the first failure. A step dropped from under
 * it would let the steps after it run where the caller's command would have
 * stopped.
 */
const ERREXIT = /^set\s+(?:-[a-zA-Z]*e[a-zA-Z]*(?:\s|$)|-o\s+errexit)/;

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
	return word.split("/").pop() ?? word;
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
 * Where the blocked steps ran relative to the remainder's steps that do work
 * (steps that only prepare the shell, such as a leading `cd`, do not count):
 * all of them before, all of them after, or some between them. The caller
 * must do the blocked steps with their tools in that place.
 */
export type BashRemainderOrder = "before" | "after" | "among";

/** The text the caller can re-send, and where the blocked steps belong around it. */
export interface BashRemainder {
	text: string;
	order: BashRemainderOrder;
}

/**
 * The text the caller can re-send after the interceptor refused the whole
 * call: `command` without every blocked step and the pipeline each one sits
 * in, or `undefined` when that text would not mean what the caller wrote.
 *
 * Nothing is offered when a dropped step leaves shell state behind (a `cd`, an
 * assignment, a `set`), when a later step reads its exit status or a file it
 * wrote, when dropping it would make a `&&`/`||` chain's later command
 * unconditional, when the command sets errexit, when the rejoined text no
 * longer parses into exactly the kept steps, when the remainder would be
 * refused in turn, or when the blocked steps sit between kept steps and one of
 * them reads a file an earlier kept step writes (no single call then keeps
 * the order the caller wrote).
 *
 * @param command The command the interceptor matched, with its original text.
 * @param segments Its segments, as the interceptor matched them.
 * @param blockedIndices Indices of the segments a rule matches, ascending.
 * @param isBlocked Whether a candidate remainder would itself be refused.
 */
export function buildBashRemainder(
	command: string,
	segments: FlatShellCommandSegment[],
	blockedIndices: number[],
	isBlocked: (candidate: string) => boolean,
): BashRemainder | undefined {
	if (blockedIndices.length === 0 || blockedIndices.some(index => !segments[index])) return undefined;

	// A pipeline's stages share one stdin/stdout chain, so each blocked stage is
	// dropped together with every stage joined to it by `|` or `|&`.
	const drop = new Set<number>();
	for (const blockedIndex of blockedIndices) {
		let first = blockedIndex;
		while (first > 0 && segments[first].pipedStdin) first--;
		let last = blockedIndex;
		while (last + 1 < segments.length && segments[last + 1].pipedStdin) last++;
		for (let index = first; index <= last; index++) drop.add(index);
	}
	const kept = segments.filter((_, index) => !drop.has(index));
	// A command word that is itself an assignment (`X=1`) sets a variable and runs nothing.
	const preparesOnly = (segment: FlatShellCommandSegment): boolean =>
		Boolean(PREPARATION_ONLY[commandWord(segment.text)]) || LEADING_ASSIGNMENT.test(commandWord(segment.text));
	if (kept.every(preparesOnly)) return undefined;

	// Dropping a step must not change what the steps after it see.
	for (const index of drop) {
		const segment = segments[index];
		const later = segments.slice(index + 1).filter((_, offset) => !drop.has(index + 1 + offset));
		if (!drop.has(index + 1) && (segment.terminator === "&&" || segment.terminator === "||")) return undefined;
		if (later.length > 0 && segments.some(step => ERREXIT.test(step.text))) return undefined;
		if (later.length === 0) continue;
		if (later.some(kept => EXIT_STATUS.test(kept.text))) return undefined;
		// `NAME=value cmd` sets NAME for `cmd` alone; only a bare `NAME=value` outlives its step.
		const word = commandWord(segment.text);
		if (LEADING_ASSIGNMENT.test(word) || STATEFUL_COMMANDS[word]) return undefined;
		const written = writtenPaths(segment.text);
		if (later.some(kept => written.some(path => kept.text.includes(path)))) return undefined;
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

	// The blocked steps are done with other tools, outside this call, so the
	// caller has to know whether they go before or after it.
	const working = segments.flatMap((segment, index) => (drop.has(index) || preparesOnly(segment) ? [] : [index]));
	const firstDropped = Math.min(...drop);
	const lastDropped = Math.max(...drop);
	if (working.every(index => index > lastDropped)) return { text: remainder, order: "before" };
	if (working.every(index => index < firstDropped)) return { text: remainder, order: "after" };
	// Kept steps run on both sides of a blocked one. One call cannot keep that
	// order, which matters as soon as a blocked step reads what an earlier kept
	// step wrote.
	for (const index of drop) {
		const earlierWrites = working
			.filter(keptIndex => keptIndex < index)
			.flatMap(keptIndex => writtenPaths(segments[keptIndex].text));
		if (earlierWrites.some(path => segments[index].text.includes(path))) return undefined;
	}
	return { text: remainder, order: "among" };
}
