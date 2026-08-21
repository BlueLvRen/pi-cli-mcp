import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sleep, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("handshake", () => {
	it("echoes a protocol version it supports", async () => {
		const client = new Client(ws.env, ws.dir);
		const init = await client.handshake();
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect(init.result.capabilities.tools).toBeDefined();
		expect(init.result.serverInfo.name).toBe("pi");
		client.close();
	});

	it("falls back to a known version when asked for an unknown one", async () => {
		const client = new Client(ws.env, ws.dir);
		const init = await client.call("initialize", {
			protocolVersion: "1999-01-01",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(init.result.protocolVersion).toBe("2025-06-18");
		client.close();
	});

	it("exposes exactly its tools", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const list = await client.call("tools/list");
		expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
			"pi",
			"pi_models",
			"pi_reply",
			"pi_running",
			"pi_send",
			"pi_sessions",
		]);
		client.close();
	});
});

describe("json-rpc conformance", () => {
	it("answers ping", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		expect((await client.call("ping")).result).toEqual({});
		client.close();
	});

	it("rejects an unknown method with -32601", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		expect((await client.call("no/such/method")).error?.code).toBe(-32601);
		client.close();
	});

	it("rejects an unknown tool with -32602", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.call("tools/call", { name: "nope", arguments: {} });
		expect(res.error?.code).toBe(-32602);
		client.close();
	});

	it("never answers a notification", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		// Requests-shaped notifications: a reply to any of these would be a
		// response with no id, which is itself invalid JSON-RPC.
		client.send({ jsonrpc: "2.0", method: "tools/list" });
		client.send({ jsonrpc: "2.0", method: "initialize", params: {} });
		client.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "pi_sessions", arguments: {} } });
		await sleep(300);
		expect(client.notifications.filter((n) => n.method === undefined)).toEqual([]);
		// The connection is still healthy afterwards.
		expect((await client.call("ping")).result).toEqual({});
		client.close();
	});

	it("reports a parse error for malformed JSON", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		client.raw("{not json}\n");
		await sleep(200);
		expect(client.notifications.some((n) => n.error?.code === -32700)).toBe(true);
		client.close();
	});

	it("reports Invalid Request for JSON that is not a request object", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		client.raw("[1,2,3]\n");
		client.raw('"a string"\n');
		await sleep(200);
		expect(client.notifications.filter((n) => n.error?.code === -32600).length).toBeGreaterThanOrEqual(2);
		client.close();
	});

	it("reports Invalid Request when jsonrpc or method is missing", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const missingMethod = await client.call2({ jsonrpc: "2.0", id: 900 });
		expect(missingMethod.error?.code).toBe(-32600);
		client.close();
	});

	it("refuses a frame larger than the limit instead of growing forever", async () => {
		const client = new Client({ ...ws.env, PI_MCP_MAX_FRAME: "100000" }, ws.dir);
		await client.handshake();
		client.raw("x".repeat(120_000));
		await sleep(300);
		expect(client.notifications.some((n) => n.error?.code === -32600 && /frame exceeded/.test(n.error.message))).toBe(
			true,
		);
		// Still usable after the bad frame is dropped.
		client.raw("\n");
		expect((await client.call("ping")).result).toEqual({});
		client.close();
	});
});
