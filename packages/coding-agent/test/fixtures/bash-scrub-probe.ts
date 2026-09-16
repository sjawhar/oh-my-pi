/**
 * Child-process probe for the tool-child credential scrub: the embedded shell
 * copies the REAL process environment (Rust `std::env`), which `bun test`
 * cannot mutate in-process, so the parent test spawns this probe with the
 * sentinel credentials in its spawn env. Runs one real bash-tool execution and
 * reports what an actual subprocess (`sh -c`) observes for a denylisted
 * credential var and a non-denylisted passthrough var.
 */
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";

const command = `sh -c 'printf "%s|%s" "\${ANTHROPIC_API_KEY-unset}" "\${OMP_SCRUB_PASSTHROUGH_PROBE-unset}"'`;
const result = await executeBash(command, { cwd: process.cwd(), timeout: 30_000 });
process.stdout.write(`${JSON.stringify({ exitCode: result.exitCode, output: result.output })}\n`);
