import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	RESERVED_CLAIMS_FILE,
	SessionManager,
	whenArtifactCopiesSettle,
} from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/session/session-manager";
import { FileSessionStorage } from "../../../../heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src/session/session-storage";

class TempDir {
	#p = fs.mkdtempSync(path.join(os.tmpdir(), "omp-probe-"));
	static createSync(_: string) {
		return new TempDir();
	}
	path() {
		return this.#p;
	}
	join(n: string) {
		return path.join(this.#p, n);
	}
	[Symbol.dispose]() {
		fs.rmSync(this.#p, { recursive: true, force: true });
	}
}

const SRC = "/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/heads/8b9cb46ff95c0c6fdc95e4bce9efe0d8db2ff59e/packages/coding-agent/src";
const SESSION_MANAGER_MODULE = `${SRC}/session/session-manager.ts`;
const SESSION_TRANSFER_MODULE = `${SRC}/session/session-transfer.ts`;

const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

async function createSession(tempDir: TempDir, firstTurn = "before"): Promise<string> {
	const c = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await c.ensureOnDisk();
	c.appendMessage(userTurn(firstTurn));
	const f = c.getSessionFile()!;
	await c.close();
	return f;
}

async function startOwner(tempDir: TempDir, sessionFile: string) {
	const script = tempDir.join("adopting-process.ts");
	await Bun.write(
		script,
		[
			`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
			`import { adoptResumedSession } from ${JSON.stringify(SESSION_TRANSFER_MODULE)};`,
			"const opened = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
			"const manager = await adoptResumedSession(opened, process.argv[3]);",
			'process.stdout.write("ready\\n");',
			"for await (const line of console) { if (line === 'close') break; }",
			"await manager.close();",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, script, sessionFile, path.dirname(sessionFile)], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const reader = child.stdout.getReader();
	let buf = "";
	while (!buf.includes("\n")) {
		const { done, value } = await reader.read();
		if (done) throw new Error(await new Response(child.stderr).text());
		buf += new TextDecoder().decode(value);
	}
	return async () => {
		child.stdin.write("close\n");
		child.stdin.end();
		await child.exited;
	};
}

it("a fork's copy settling after the manager moved on writes into the new session's state", async () => {
	using tempDir = TempDir.createSync("@omp-probe-");
	const original = await createSession(tempDir);
	const replacement = await createSession(tempDir, "someone else's conversation");
	const artifacts = original.slice(0, -".jsonl".length);
	fs.mkdirSync(artifacts, { recursive: true });
	fs.writeFileSync(path.join(artifacts, "0.bash.log"), "this session's artifact");
	const w = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), { suppressBreadcrumb: true });
	w.appendMessage(userTurn("see artifact://0"));
	await w.close();

	const closeOwner = await startOwner(tempDir, original);
	try {
		const resuming = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		await resuming.ensureOnDisk();
		const realpath = fs.promises.realpath;
		const spy = spyOn(fs.promises, "realpath").mockImplementation((async (t: fs.PathLike) => {
			if (t === original && fs.existsSync(replacement)) fs.renameSync(replacement, original);
			return realpath(t);
		}) as typeof fs.promises.realpath);
		let forkFile: string;
		try {
			const { forkedFrom } = await resuming.setSessionFile(original, { forkIfContested: true });
			forkFile = resuming.getSessionFile()!;
			console.log("forkedFrom:", forkedFrom?.reason, "fork:", path.basename(forkFile));
			// The user moves on (/new) while the fork's artifacts are still being copied.
			await resuming.newSession();
			console.log("after /new: id", resuming.getSessionId(), "lossReason", resuming.artifactLossReason());
			await whenArtifactCopiesSettle(artifactsDirectoryOf(forkFile));
			await Bun.sleep(200);
		} finally {
			spy.mockRestore();
		}
		console.log("new session: artifactsReproduced =", await resuming.artifactsReproduced());
		console.log("new session: artifactLossReason =", JSON.stringify(resuming.artifactLossReason()));
		const claims = path.join(artifactsDirectoryOf(forkFile), RESERVED_CLAIMS_FILE);
		console.log("fork dir claims file exists:", fs.existsSync(claims), fs.existsSync(claims) ? fs.readFileSync(claims, "utf8") : "");
		await resuming.close();
	} finally {
		await closeOwner();
	}
	expect(true).toBe(true);
}, 30_000);

function artifactsDirectoryOf(f: string) {
	return f.slice(0, -".jsonl".length);
}
