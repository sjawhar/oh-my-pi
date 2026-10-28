/**
 * List Python eval runners on this host that no live kernel will ever use again.
 *
 * Read-only: it reads `/proc` and prints. It signals nothing and kills nothing.
 *
 * Two classes are reported.
 *
 *   orphan    the spawning parent is gone: `/proc/<ppid>` is missing, or the
 *             pid was recycled by a process that started after the runner. The
 *             runner polls `getppid()` every 10s and exits when it is
 *             reparented, so a persistent orphan means that poll never ran.
 *
 *   stranded  the parent is alive, but another runner under that same parent
 *             serves the same agent session. A retained
 *             kernel is keyed by (eval session id, cwd, interpreter) and the
 *             eval session id is `…:cwd:<cwd>`, so one agent session can have
 *             at most one kernel its next cell will use. Every other runner in
 *             the group is heap the host will not reclaim before it exits.
 *
 * What does NOT work, measured rather than assumed: the control channel between
 * omp and a runner it has walked away from stays open at both ends — `ss -x`
 * shows the host still holding all three stdio sockets of a stranded runner —
 * so no `lsof` or `/proc/<pid>/fd` comparison separates a stranded runner from
 * a live one. Neither does idleness: a legitimately retained kernel is idle and
 * fat too. The grouping above is the signal; RSS and CPU only rank it.
 *
 * False positives, stated plainly because output invites a `kill`:
 *
 *   - A group of N runners means N-1 are unreclaimable. That part is exact.
 *   - WHICH member is still reachable cannot be read from outside the host
 *     process. This script assumes the newest-started member is the live one.
 *     An agent that returns to a directory it used earlier makes an older
 *     member live again and the newest one stranded, so a `kill` driven from
 *     this output can end one kernel a session could still have used. The cost
 *     is that session's in-memory Python state and any cell running in it;
 *     `--busy` shows which members are running a cell right now (threads above
 *     the idle baseline), and those should never be killed.
 *   - Runners with no `PI_SESSION_FILE` (the host had not yet written the
 *     session to disk) are grouped per parent as `<unsaved session>`; unrelated
 *     SDK sessions in one process can land in one such group, so those groups
 *     are listed but never marked stranded.
 *
 * Usage: bun scripts/find-stranded-eval-runners.ts [--json] [--all] [--busy]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const RUNNER_MARKER = "omp-python-runner";
const UNSAVED_SESSION = "<unsaved session>";
const CLOCK_TICKS_PER_SECOND = 100;

interface RunnerProcess {
	pid: number;
	ppid: number;
	/** Resident set size in bytes. */
	rss: number;
	/** Seconds of user+system CPU the runner has burned. */
	cpuSeconds: number;
	/** Seconds since the runner started. */
	ageSeconds: number;
	threads: number;
	cwd: string;
	sessionFile: string;
	evalSessionId: string;
	parentCommand: string;
	/** The spawning parent is still alive: it exists and predates the runner, so the pid was not recycled. */
	parentAlive: boolean;
}

interface RunnerGroup {
	ppid: number;
	sessionFile: string;
	parentAlive: boolean;
	runners: RunnerProcess[];
}

interface Finding {
	kind: "orphan" | "stranded";
	runner: RunnerProcess;
	/** The runner this script believes the session is using, for stranded findings. */
	liveSibling?: number;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function readLink(file: string): string {
	try {
		return fs.readlinkSync(file);
	} catch {
		return "<unreadable>";
	}
}

function readEnviron(pid: number): Record<string, string> {
	const raw = readText(`/proc/${pid}/environ`);
	if (raw === undefined) return {};
	const env: Record<string, string> = {};
	for (const entry of raw.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return env;
}

/** `/proc/<pid>/stat` after the comm field, which may itself contain spaces and parentheses. */
function readStatFields(pid: number): string[] | undefined {
	const raw = readText(`/proc/${pid}/stat`);
	if (raw === undefined) return undefined;
	const close = raw.lastIndexOf(")");
	if (close < 0) return undefined;
	return raw.slice(close + 2).split(" ");
}

function collectRunners(): RunnerProcess[] {
	const uptimeSeconds = Number((readText("/proc/uptime") ?? "0").split(" ")[0]);
	const pageSize = 4096;
	const runners: RunnerProcess[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		const cmdline = readText(`/proc/${pid}/cmdline`);
		if (cmdline === undefined || !cmdline.includes(RUNNER_MARKER)) continue;
		const fields = readStatFields(pid);
		if (fields === undefined || fields[0] === "Z") continue;
		const ppid = Number(fields[1]);
		const parentFields = readStatFields(ppid);
		const parentCommand = (readText(`/proc/${ppid}/cmdline`) ?? "").replaceAll("\0", " ").trim();
		const startTicks = Number(fields[19]);
		const env = readEnviron(pid);
		runners.push({
			pid,
			ppid,
			rss: Number(fields[21]) * pageSize,
			cpuSeconds: (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS_PER_SECOND,
			ageSeconds: Math.max(0, uptimeSeconds - startTicks / CLOCK_TICKS_PER_SECOND),
			threads: Number(fields[17]),
			cwd: readLink(`/proc/${pid}/cwd`),
			sessionFile: env.PI_SESSION_FILE ?? UNSAVED_SESSION,
			evalSessionId: env.PI_TOOL_BRIDGE_SESSION ?? "<unknown>",
			parentCommand,
			// A parent that started after its child is a recycled pid, not the spawner.
			parentAlive: parentFields !== undefined && Number(parentFields[19]) <= startTicks,
		});
	}
	return runners;
}

function groupRunners(runners: readonly RunnerProcess[]): RunnerGroup[] {
	const groups = new Map<string, RunnerGroup>();
	for (const runner of runners) {
		const key = `${runner.ppid}\0${runner.sessionFile}`;
		const group = groups.get(key);
		if (group) group.runners.push(runner);
		else
			groups.set(key, {
				ppid: runner.ppid,
				sessionFile: runner.sessionFile,
				parentAlive: runner.parentAlive,
				runners: [runner],
			});
	}
	for (const group of groups.values()) group.runners.sort((a, b) => b.ageSeconds - a.ageSeconds);
	return [...groups.values()];
}

function findLeaks(groups: readonly RunnerGroup[]): Finding[] {
	const findings: Finding[] = [];
	for (const group of groups) {
		if (!group.parentAlive) {
			for (const runner of group.runners) findings.push({ kind: "orphan", runner });
			continue;
		}
		if (group.sessionFile === UNSAVED_SESSION || group.runners.length < 2) continue;
		// Oldest first, so the last entry is the newest start: the kernel this
		// script treats as the one the session is still using.
		const live = group.runners[group.runners.length - 1];
		for (const runner of group.runners.slice(0, -1)) {
			findings.push({ kind: "stranded", runner, liveSibling: live.pid });
		}
	}
	return findings;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
	return `${Math.round(bytes / 1024 ** 2)}M`;
}

function formatDuration(seconds: number): string {
	if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d${Math.floor((seconds % 86_400) / 3600)}h`;
	if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
	return `${Math.floor(seconds / 60)}m`;
}

const args = new Set(Bun.argv.slice(2));
const runners = collectRunners();
const groups = groupRunners(runners);
const findings = findLeaks(groups).sort((a, b) => b.runner.rss - a.runner.rss);

if (args.has("--json")) {
	console.log(JSON.stringify({ scanned: runners.length, groups: groups.length, findings }, null, 2));
	process.exit(0);
}

const reclaimable = findings.reduce((total, finding) => total + finding.runner.rss, 0);
console.log(
	`scanned ${runners.length} runner(s) in ${groups.length} session group(s); ` +
		`${findings.length} unreclaimable holding ${formatBytes(reclaimable)}`,
);

if (findings.length > 0) {
	console.log("");
	console.log(
		["kind".padEnd(8), "pid".padStart(8), "omp".padStart(8), "rss".padStart(7), "age".padStart(7), "cpu".padStart(7)]
			.join(" ")
			.concat(args.has("--busy") ? "  thr" : "", "  cwd / session"),
	);
}
for (const finding of findings) {
	const { runner } = finding;
	console.log(
		[
			finding.kind.padEnd(8),
			String(runner.pid).padStart(8),
			String(runner.ppid).padStart(8),
			formatBytes(runner.rss).padStart(7),
			formatDuration(runner.ageSeconds).padStart(7),
			`${runner.cpuSeconds.toFixed(0)}s`.padStart(7),
		]
			.join(" ")
			.concat(args.has("--busy") ? `  ${String(runner.threads).padStart(3)}` : "", `  ${runner.cwd}`),
	);
	if (finding.liveSibling !== undefined) {
		console.log(`${" ".repeat(9)}superseded by pid ${finding.liveSibling} in ${path.basename(runner.sessionFile)}`);
	}
}

if (args.has("--all")) {
	console.log("\nall session groups:");
	for (const group of groups) {
		console.log(`  omp ${group.ppid} ${group.sessionFile}`);
		for (const runner of group.runners) {
			console.log(`    pid ${String(runner.pid).padStart(8)} ${formatBytes(runner.rss).padStart(7)} ${runner.cwd}`);
		}
	}
}

if (findings.length > 0) {
	console.log(
		"\nNothing was signalled. Read the false-positive notes at the top of this script before killing anything:",
	);
	console.log(`  kill ${findings.map(finding => finding.runner.pid).join(" ")}`);
}
