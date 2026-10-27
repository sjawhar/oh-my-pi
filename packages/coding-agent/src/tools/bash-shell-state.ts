/**
 * What an earlier bash call left in the session's shell.
 *
 * A session's foreground calls share one persistent shell, so a `set -e`, a
 * `shopt -s -o errexit` or a `trap … ERR` from one call is still in force when
 * the next one is checked. Under it every `;` behaves like `&&`, which decides
 * whether a refusal may offer a runnable remainder at all.
 *
 * The native shell exposes no way to read its options back, so the tool
 * records what it ran instead: once a call that could have turned the option
 * on has run, the session is treated as stopping on the first error for the
 * rest of its life. A later `set +e` is not seen, and neither is a shell the
 * session dropped — both only withhold more offers, never fewer.
 */
import { commandEnablesErrexit } from "./bash-remainder";

/** Sessions whose shell may stop at the first failing command, keyed as the executor keys its shells. */
const stoppingOnError = new Set<string>();

/** Records what a bash call about to run could leave in its session's shell. */
export function noteBashShellState(sessionId: string | undefined, command: string): void {
	if (commandEnablesErrexit(command)) stoppingOnError.add(sessionId ?? "");
}

/** Whether an earlier call in this session's shell could have left it stopping on the first error. */
export function bashShellStopsOnError(sessionId: string | undefined): boolean {
	return stoppingOnError.has(sessionId ?? "");
}

/** Drops what a session's shell held, once that shell itself is gone. */
export function forgetBashShellState(sessionId: string | undefined): void {
	stoppingOnError.delete(sessionId ?? "");
}
