/**
 * Subagent session discovery shared by `/export` (HTML) and `/dump all` (zip of text dumps).
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Advisor
 * transcripts (`__advisor*.jsonl`) share those directories and are not subagents.
 */
import * as path from "node:path";
import { isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { getAgentTombstonePath } from "../registry/agent-tombstone";
import { resolveSessionLeafId, type SessionEntry, type SessionHeader } from "./session-entries";
import { loadSessionFile } from "./session-loader";
import { defaultSessionStorage, type SessionStorage } from "./session-storage";

/** Persisted subagent session transcript, keyed by slash-joined agent path. */
export interface SubSession {
	/** Bare agent id (session file stem), e.g. "ToolAsk". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	/** The subagent was explicitly killed (a tombstone sidecar sits next to its transcript). */
	aborted: boolean;
	/** JSONL records skipped as malformed while loading this transcript. */
	malformedRecords: number;
}

/** Receives the key of a subagent transcript that exists but has no readable session header. */
export type UnreadableSubSessionHandler = (key: string) => void;

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * Keys in the returned record are slash-joined ids relative to the main session
 * ("ToolAsk", "ToolAsk/Helper"). Empty files are skipped silently; corrupt ones
 * are skipped and reported to `onUnreadable`.
 */
export async function collectSubSessions(
	sessionFile: string,
	onUnreadable?: UnreadableSubSessionHandler,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!sessionFile.endsWith(".jsonl")) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result, onUnreadable, storage);
	return result;
}

/** One file stored directly in a subagent directory, in name order. */
interface StoredSubSessionFile {
	name: string;
	/** Path the storage holds the file under. */
	file: string;
	/** The subagent was explicitly killed. */
	aborted: boolean;
	/** The directory named after the file's stem holds that subagent's own children. */
	descend: boolean;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
	onUnreadable: UnreadableSubSessionHandler | undefined,
	storage: SessionStorage,
): Promise<void> {
	for (const { name, file, aborted, descend } of await listStoredFiles(dir, storage)) {
		if (name.includes(".bak") || isAdvisorTranscriptName(name)) continue;
		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const { entries: fileEntries, malformedRecords, invalidHeader } = await loadSessionFile(file, storage);
		// Empty files load as [] and are skipped; a corrupt or missing header is reported so exports do
		// not look complete while omitting the transcript.
		if (fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: resolveSessionLeafId(entries),
				aborted,
				malformedRecords,
			};
		} else if (invalidHeader) {
			onUnreadable?.(key);
		}
		if (descend) await collectSubSessionsFromDir(path.join(dir, agentId), key, out, onUnreadable, storage);
	}
}

/**
 * Transcripts the storage holds directly under `dir`, in name order, with the
 * two sidecar facts the walk needs. Only directories the storage reports are
 * descended into: a transcript stem such as "." or ".." would revisit an
 * ancestor, and a symlinked directory can loop back into the tree. Kill
 * tombstones are local files beside the transcript path, whatever store holds
 * the transcript itself.
 */
async function listStoredFiles(dir: string, storage: SessionStorage): Promise<StoredSubSessionFile[]> {
	const childDirectories = new Set(storage.listDirsSync(dir));
	const byName = new Map(storage.listFilesSync(dir, "*.jsonl").map(file => [path.basename(file), file]));
	return Promise.all(
		[...byName.keys()].sort().map(async name => {
			const file = byName.get(name)!;
			return {
				name,
				file,
				aborted: await Bun.file(getAgentTombstonePath(file)).exists(),
				descend: childDirectories.has(name.slice(0, -6)),
			};
		}),
	);
}
