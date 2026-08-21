// Two transports, one interface. The rpc one exists for a single capability:
// reaching a turn that is already running.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, sleep, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("transport selection", () => {
	it("defaults to print", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
	});

	it("runs a turn over rpc and returns the same shape of answer", async () => {
		const client = new Client({ ...ws.env, FAKE_RPC_SETTLE_MS: "200" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir, transport: "rpc" });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("RPC ANSWER");
		// Same stats line, because both transports feed the same accumulator.
		expect(res.text).toMatch(/\npi: .+ · \d+ turn/);
		expect(res.text).toMatch(/\[session: [0-9a-f-]{36}\]/);
	});

	it("can be set as the server default", async () => {
		const client = new Client({ ...ws.env, PI_MCP_TRANSPORT: "rpc", FAKE_RPC_SETTLE_MS: "200" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.text).toContain("RPC ANSWER");
	});

	it("rejects an unknown transport", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir, transport: "carrier-pigeon" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("unknown transport");
	});

	it("works for pi_reply too", async () => {
		const client = new Client({ ...ws.env, FAKE_RPC_SETTLE_MS: "150" }, ws.dir);
		await client.handshake();
		const first = await client.tool("pi", { prompt: "go", cwd: ws.dir, transport: "rpc" });
		const id = sessionIdOf(first.text);
		const reply = await client.tool("pi_reply", { session: id, prompt: "again", transport: "rpc" });
		client.close();
		expect(reply.isError).toBe(false);
		expect(reply.text).toContain("RPC ANSWER");
	});
});

describe("reaching a running turn", () => {
	it("delivers a steer into a turn that is already working", async () => {
		// No auto-settle: the turn waits, exactly like a long task would.
		const client = new Client({ ...ws.env }, ws.dir);
		await client.handshake();

		const call = client.request("tools/call", {
			name: "pi",
			arguments: { prompt: "long task", cwd: ws.dir, transport: "rpc" },
		});
		await sleep(700);

		// The running turn is visible, and its session id is how it is addressed.
		const running = await client.tool("pi_running");
		expect(running.text).toContain(ws.dir);
		const id = running.text.split("\n").at(-1)?.split(/\s+/)[0] ?? "";
		expect(id).toMatch(/^[0-9a-f-]{36}$/);

		const sent = await client.tool("pi_send", { session: id, message: "wrap up now" });
		expect(sent.isError).toBe(false);
		expect(sent.text).toContain("Sent steer");

		// The answer of the still-waiting call reflects the message.
		const res = (await call.promise).result;
		client.close();
		expect(res.isError).toBeUndefined();
		expect(res.content[0].text).toContain("STEERED: wrap up now");
	});

	it("supports follow_up and abort", async () => {
		for (const [command, expected] of [
			["follow_up", "FOLLOW_UP QUEUED: later"],
			["abort", "ABORTED"],
		] as const) {
			const client = new Client({ ...ws.env }, ws.dir);
			await client.handshake();
			const call = client.request("tools/call", {
				name: "pi",
				arguments: { prompt: "long task", cwd: ws.dir, transport: "rpc" },
			});
			await sleep(600);
			const id = (await client.tool("pi_running")).text.split("\n").at(-1)?.split(/\s+/)[0] ?? "";
			await client.tool("pi_send", { session: id, message: "later", command });
			const res = (await call.promise).result;
			client.close();
			expect(res.content[0].text).toContain(expected);
		}
	});

	it("says so plainly when the session is not running", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("pi_send", {
			session: "00000000-0000-4000-8000-000000000000",
			message: "hello",
		});
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("not currently running");
		// And points at the right tool for a finished session.
		expect(res.text).toContain("pi_reply");
	});

	it("cannot reach a print-transport run, and explains why", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "slow", FAKE_DELAY_MS: "900" }, ws.dir);
		await client.handshake();
		const call = client.request("tools/call", {
			name: "pi",
			arguments: { prompt: "go", cwd: ws.dir },
		});
		await sleep(400);
		const running = await client.tool("pi_running");
		expect(running.text).toContain("No pi turn is running under the rpc transport");
		await call.promise;
		client.close();
	});

	it("validates its input", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const noSession = await client.tool("pi_send", { message: "x" });
		const badCommand = await client.tool("pi_send", { session: "s", message: "x", command: "yell" });
		const noMessage = await client.tool("pi_send", { session: "s", command: "steer" });
		client.close();
		expect(noSession.isError).toBe(true);
		expect(noSession.text).toContain("`session` is required");
		expect(badCommand.isError).toBe(true);
		expect(badCommand.text).toContain("steer, follow_up, or abort");
		expect(noMessage.isError).toBe(true);
		expect(noMessage.text).toContain("`message` is required");
	});
});
