import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const SKILL = "upgrade-skill";

/**
 * `omp plugin upgrade` installs a marketplace plugin's new version in a new
 * cache directory (`<marketplace>___<plugin>___<version>`), points the
 * registry at it and deletes the old version's directory. A session that
 * discovered its skills before the upgrade must keep reading them.
 */
describe("skill:// after a plugin upgrade replaces the plugin's version directory", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-upgrade-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-upgrade-project-"));
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-upgrade-home-"));
		process.env.HOME = tempHomeDir;
		// Discovery reads `os.homedir()` and the agent dir; left alone they scan the real user's plugins and skills.
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		installPluginVersion("1.0.0");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
		__resetDirsFromEnvForTests();
	});

	function pluginDir(version: string): string {
		return path.join(tempHomeDir, ".omp", "plugins", "cache", "plugins", `market___upgrade-plugin___${version}`);
	}

	/** What `omp plugin upgrade` leaves on disk: the new version installed and registered, the old one deleted. */
	function installPluginVersion(version: string, previous?: string): void {
		const skillDir = path.join(pluginDir(version), "skills", SKILL);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${SKILL}\ndescription: Plugin skill.\n---\n\nBody of version ${version}.\n`,
		);
		fs.writeFileSync(path.join(skillDir, "notes.md"), `Notes of version ${version}.\n`);
		fs.writeFileSync(
			path.join(tempHomeDir, ".omp", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "upgrade-plugin@market": [{ scope: "user", installPath: pluginDir(version), version }] },
			}),
		);
		if (previous) removeSyncWithRetries(pluginDir(previous));
	}

	async function startSession(options: { skills?: AgentSession["skills"] } = {}): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated({
				"skills.enabled": true,
				"skills.enableCodexUser": false,
				"skills.enableClaudeUser": false,
				"skills.enableClaudeProject": false,
			}),
			...(options.skills ? { skills: [...options.skills] } : {}),
		});
		sessions.push(session);
		return session;
	}

	async function readText(session: AgentSession, url: string): Promise<string> {
		const result = await session.getToolByName("read")!.execute(`read-${url}`, { path: url });
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	}

	it("a session that discovered the skill reads the new version and its skill list follows", async () => {
		const session = await startSession();
		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 1.0.0.");

		installPluginVersion("2.0.0", "1.0.0");

		expect(await readText(session, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
		expect(await readText(session, `skill://${SKILL}/notes.md`)).toContain("Notes of version 2.0.0.");
		// The session's own list is healed, so subagents it spawns from now on inherit the new path.
		const skill = session.skills.find(entry => entry.name === SKILL);
		expect(skill?.filePath.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("a session handed a fixed skill list (a subagent's inherited skills) reads the new version", async () => {
		const parent = await startSession();
		const child = await startSession({ skills: parent.skills });

		installPluginVersion("2.0.0", "1.0.0");

		expect(await readText(child, `skill://${SKILL}`)).toContain("Body of version 2.0.0.");
	});
});
