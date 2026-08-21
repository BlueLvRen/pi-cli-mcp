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
	it("defaults to rpc", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
		// Reachable while running is the rpc-only capability; print has nothing to
		// talk to. A default-transport run must therefore be an rpc one.
		expect(res.text).toMatch(/\[session: [0-9a-f-]{36}\]/);
	});

	it("still runs a turn over print when asked", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir, transport: "print" });
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

	it("honours PI_MCP_TRANSPORT for the default", async () => {
		const client = new Client({ ...ws.env, PI_MCP_TRANSPORT: "print", FAKE_MODE: "no_stop" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();
		// print mode reaches the same scenario; the point is the env var is read.
		expect(res.text).toContain("ANSWER WITHOUT STOP REASON");
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
		const client = new Client({ ...ws.env, FAKE_RPC_WAIT: "1" }, ws.dir);
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
			const client = new Client({ ...ws.env, FAKE_RPC_WAIT: "1" }, ws.dir);
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
			// Explicit: rpc is the default now, and an rpc run would be reachable.
			arguments: { prompt: "go", cwd: ws.dir, transport: "print" },
		});
		await sleep(400);
		const running = await client.tool("pi_running");
		expect(running.text).toContain("No pi turn is running under the rpc transport");
		await call.promise;
		client.close();
	});

	it("ends a cancelled turn in-protocol, so its report still arrives", async () => {
		// pi skips its stdout flush on SIGTERM, so signalling first can cost the tail
		// of the stream. rpc sends `abort` instead and the turn reports normally.
		const client = new Client({ ...ws.env, FAKE_RPC_WAIT: "1" }, ws.dir);
		await client.handshake();
		const call = client.request("tools/call", {
			name: "pi",
			arguments: { prompt: "long task", cwd: ws.dir, transport: "rpc" },
		});
		await sleep(600);
		client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: call.id, reason: "test" },
		});
		const res = (await call.promise).result;
		client.close();

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("cancelled");
		// The turn's own report survived the cancellation.
		expect(res.content[0].text).toContain("ABORTED");
		expect(res.content[0].text).toContain("pi_reply(");
	});

	it("still kills a turn that ignores the abort", async () => {
		// PI_MCP_TIMEOUT_MS has a 1000 ms floor; anything lower is ignored and the
		// 30-minute default applies.
		const client = new Client(
			{
				...ws.env,
				FAKE_RPC_WAIT: "1",
				FAKE_RPC_IGNORE_ABORT: "1",
				PI_MCP_ABORT_GRACE_MS: "300",
				PI_MCP_TIMEOUT_MS: "1200",
			},
			ws.dir,
		);
		await client.handshake();
		const started = Date.now();
		const res = await client.tool("pi", { prompt: "long task", cwd: ws.dir, transport: "rpc" });
		const elapsed = Date.now() - started;
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("timed out");
		// Deadline, then the abort grace, then signals — not an unbounded wait.
		expect(elapsed).toBeLessThan(6000);
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
