import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { buildSkillPromptMessage } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "./helpers/session-defaults";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const SKILL = "upgrade-skill";

/**
 * `omp plugin upgrade` installs a marketplace plugin's new version in a new
 * cache directory (`<marketplace>___<plugin>___<version>`), points the
 * registry at it and deletes the old version's directory. A session that
 * discovered its skills before the upgrade must keep reading them.
 */
describe("a plugin upgrade that replaces the plugin's version directory under a running session", () => {
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

	function skillsSettings(): Settings {
		return Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
		});
	}

	async function startSession(options: { skills?: AgentSession["skills"] } = {}): Promise<AgentSession> {
		const { session } = await sdkModule.createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: skillsSettings(),
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

	it("a /skill: invocation from a running session (TUI, ACP, RPC) sends the new version", async () => {
		const session = await startSession();
		const skill = session.skills.find(entry => entry.name === SKILL)!;

		installPluginVersion("2.0.0", "1.0.0");

		const built = await buildSkillPromptMessage(skill, { args: "" }, "user", session);
		expect(built.message).toContain("Body of version 2.0.0.");
		expect(built.details.path.startsWith(pluginDir("2.0.0"))).toBe(true);
	});

	it("a subagent spawned with an autoload skill after the upgrade receives the new version", async () => {
		const parent = await startSession();
		const skill = parent.skills.find(entry => entry.name === SKILL)!;

		installPluginVersion("2.0.0", "1.0.0");

		// The child is a session fake (no model to run), but its skill list, settings and rediscovery
		// host are what the executor creates: the parent's list, fixed, and AgentSession's own host.
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const child = {
			...createSessionDefaults(),
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			skills: parent.skills,
			settings: skillsSettings(),
			sessionManager: { appendSessionInit: () => {}, getCwd: () => tempDir },
			refreshSkills: async () => {},
			skillRediscoveryHost: AgentSession.prototype.skillRediscoveryHost,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-1",
						toolName: "yield",
						result: { content: [{ type: "text", text: "done" }], details: { status: "success", data: {} } },
						isError: false,
					});
				}
				return true;
			},
			sendCustomMessage: vi.fn(async () => {}),
		} as unknown as AgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: child,
			extensionsResult: {} as sdkModule.CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		});

		await runSubprocess({
			cwd: tempDir,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "do work",
			index: 0,
			id: "upgrade-subagent",
			settings: skillsSettings(),
			modelRegistry: sharedModelRegistry,
			enableLsp: false,
			skills: [...parent.skills],
			autoloadSkills: [skill],
		});

		const sendCustomMessage = child.sendCustomMessage as Mock<AgentSession["sendCustomMessage"]>;
		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: expect.stringContaining("Body of version 2.0.0."),
				details: expect.objectContaining({ path: expect.stringContaining(pluginDir("2.0.0")) }),
			}),
			{ triggerTurn: false },
		);
	});
});
