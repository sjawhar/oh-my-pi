/**
 * A remote MCP server that is restarting (a phone app being updated, a
 * container rolling) comes back on its own schedule. Before this change the
 * manager gave up after its fixed reconnect ladder and waited for the next
 * tool call, so a client that relied on server-pushed notifications kept
 * stale resource subscriptions and heard nothing until it happened to call
 * a tool (dojo#77: a lifter's chat message went unanswered for a workout).
 *
 * The contract: an `http` server that is still down when the ladder ends is
 * retried at the persistent interval until the window closes, a manual
 * reconnect does not wait out that interval, and a server that never comes
 * back is given up on when the window closes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

/** A minimal Streamable HTTP MCP server whose availability the test flips. */
function startFlakyServer(): { url: string; down: boolean; initializes: number; stop(): void } {
	const state = { down: false, initializes: 0 };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (state.down) return new Response("restarting", { status: 503 });
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method !== "POST") return new Response(null, { status: 200 });
			const message = (await request.json()) as { id?: number; method: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (message.method === "initialize") {
				state.initializes += 1;
				result = {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "flaky", version: "0" },
				};
			} else if (message.method === "tools/list") {
				result = { tools: [] };
			}
			return Response.json(
				{ jsonrpc: "2.0", id: message.id, result },
				{ headers: { "Mcp-Session-Id": `s${state.initializes}` } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		get down() {
			return state.down;
		},
		set down(value: boolean) {
			state.down = value;
		},
		get initializes() {
			return state.initializes;
		},
		stop: () => server.stop(true),
	};
}

const FAST_POLICY: MCPReconnectPolicy = { ladderMs: [10, 10], persistentIntervalMs: 100, persistentWindowMs: 5_000 };

describe("MCP persistent reconnect for remote servers", () => {
	let workDir: string;
	const cleanups: Array<() => void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		if (workDir) removeSyncWithRetries(workDir);
	});

	async function connectedManager(policy: MCPReconnectPolicy) {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-persistent-"));
		const flaky = startFlakyServer();
		cleanups.push(flaky.stop);
		const manager = new MCPManager(workDir, null, undefined, policy);
		cleanups.push(() => void manager.disconnectAll());
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url };
		const statuses: McpConnectionStatusEvent["type"][] = [];
		manager.addConnectionStatusListener(event => statuses.push(event.type));
		await manager.connectServers({ flaky: config }, {});
		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		return { manager, flaky, statuses };
	}

	it("keeps retrying after the ladder and reconnects when the server comes back", async () => {
		const { manager, flaky, statuses } = await connectedManager(FAST_POLICY);
		flaky.down = true;
		const before = flaky.initializes;

		const reconnect = manager.reconnectServer("flaky");
		// The ladder (2 attempts + the final one) has run and failed well before this.
		await Bun.sleep(300);
		expect(statuses).toContain("failed");
		expect(manager.getConnectionStatus("flaky")).not.toBe("connected");

		flaky.down = false;
		const connection = await reconnect;

		expect(connection).not.toBeNull();
		expect(flaky.initializes).toBeGreaterThan(before);
		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		expect(statuses.indexOf("connected", statuses.indexOf("failed"))).toBeGreaterThan(-1);
	});

	it("a manual reconnect does not wait out the persistent interval", async () => {
		const policy: MCPReconnectPolicy = { ...FAST_POLICY, persistentIntervalMs: 60_000 };
		const { manager, flaky } = await connectedManager(policy);
		flaky.down = true;

		const reconnect = manager.reconnectServer("flaky");
		await Bun.sleep(200);
		flaky.down = false;
		const started = Date.now();
		const manual = manager.reconnectServer("flaky", { manual: true });

		expect(await manual).not.toBeNull();
		expect(await reconnect).not.toBeNull();
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("gives up once the window closes on a server that never comes back", async () => {
		const policy: MCPReconnectPolicy = { ...FAST_POLICY, persistentWindowMs: 400 };
		const { manager, flaky } = await connectedManager(policy);
		flaky.down = true;

		const started = Date.now();
		expect(await manager.reconnectServer("flaky")).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(400);
		expect(manager.getConnectionStatus("flaky")).not.toBe("connected");
	});
});
