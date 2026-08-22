// What a dying run reports. The rule: a killed run must leave the caller able to
// resume, and must never dump transcript data into the response.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, sleep, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

// Unique per file: test files run in parallel and would otherwise reap each
// other's grandchildren.
const CHILD_TAG = "pi-cli-mcp-failure-child";

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("a run killed by the deadline", () => {
	it("returns the session id, so the work is parked and not lost", async () => {
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG, PI_MCP_TIMEOUT_MS: "1200" },
			ws.dir,
		);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toMatch(/\[session: [0-9a-f-]{36}\]/);
		expect(res.text).toContain("timed out");
		// And it says how to pick the work back up.
		expect(res.text).toContain("pi_reply(");
		expect(res.text).toContain("resumable");
	});

	it("reports what pi managed to do before it died", async () => {
		// A run that used a tool and narrated, then hangs before settling.
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "hang_after_work", FAKE_CHILD_TAG: CHILD_TAG, PI_MCP_TIMEOUT_MS: "1500" },
			ws.dir,
		);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(true);
		// The progress the accumulator gathered survives the failure.
		expect(res.text).toContain("progress before it died");
		expect(res.text).toMatch(/tool call/);
		expect(res.text).toContain("pi wrote: note.md");
		// The last thing pi said is the strongest hint about whether it finished.
		expect(res.text).toContain("PARTIAL: 43 tests pass");
	});

	it("keeps the session resumable after the timeout", async () => {
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG, PI_MCP_TIMEOUT_MS: "1200" },
			ws.dir,
		);
		await client.handshake();
		const killed = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(killed.text);

		// The session must be listed even though the run failed: pi_reply needs to
		// know its directory.
		expect((await client.tool("pi_sessions")).text).toContain(id);

		// And resuming it works — the fake answers normally on the second leg,
		// because this client's env no longer forces the hang mode.
		const resumed = await client.tool("pi_reply", { session: id, prompt: "continue" });
		client.close();
		expect(resumed.isError).toBe(true);
		// Still the hang fixture, so it times out again — but on the same session,
		// which is the point: the id stayed usable.
		expect(resumed.text).toContain(id);
	});
});

describe("cancellation reports the same way", () => {
	it("names the session and how to resume", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		const call = client.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: ws.dir } });
		await sleep(600);
		client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: call.id, reason: "test" },
		});
		const res = (await call.promise).result;
		client.close();

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/\[session: [0-9a-f-]{36}\]/);
		expect(res.content[0].text).toContain("cancelled");
		expect(res.content[0].text).toContain("pi_reply(");
	});
});

describe("stderr never carries transcript data", () => {
	it("suppresses serialized events and says how many were dropped", async () => {
		// The fake writes JSONL message pairs to stderr, the way a failing pi run
		// dumps its session payload — including the full prompt.
		const client = new Client({ ...ws.env, FAKE_MODE: "noisy_stderr", FAKE_EXIT: "1" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(true);
		// The one useful line survives...
		expect(res.text).toContain("Error: upstream refused the request");
		// ...the transcript content does not.
		expect(res.text).not.toContain("SECRET_PROMPT_BODY");
		expect(res.text).not.toContain('"role"');
		// What is reported instead is the tally from the same parse that classified
		// those lines: the event types, not their payloads.
		expect(res.text).toMatch(/protocol event line\(s\) on stderr, suppressed: /);
		expect(res.text).toContain("message_start×2");
		// And the whole failure stays small enough to be worth reading.
		expect(res.text.length).toBeLessThan(4000);
	});
});

describe("a turn that pi itself failed", () => {
	it("leads with pi's own reason instead of reporting an empty answer", async () => {
		// pi's contract for a failed turn is stopReason "error" plus errorMessage and
		// no text. Reporting only "no answer text" is true and useless — the reason
		// is the one actionable thing in the response.
		const client = new Client({ ...ws.env, FAKE_MODE: "error_turn" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("context window exceeded");
		// And the classification still says what happened.
		expect(res.text).toContain("stopReason=error");
		// Diagnostics pi attached are surfaced, not the transcript.
		expect(res.text).toContain("provider_error: upstream 400");
	});

	it("carries the reason for a session that cannot be read", async () => {
		const client = new Client(
			{
				...ws.env,
				FAKE_MODE: "error_turn",
				FAKE_ERROR_MESSAGE: "failed to read session file: no space left on device",
			},
			ws.dir,
		);
		await client.handshake();
		const res = await client.tool("pi_reply", {
			session: "11111111-1111-4111-8111-111111111111",
			prompt: "go",
			cwd: ws.dir,
		});
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("no space left on device");
	});
});

describe("per-call timeout", () => {
	it("is accepted and overrides the server default", async () => {
		// Server default is generous; the call asks for a short one and hits it.
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG, PI_MCP_TIMEOUT_MS: "600000" },
			ws.dir,
		);
		await client.handshake();
		const started = Date.now();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir, timeout_ms: 1200 });
		const elapsed = Date.now() - started;
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("timed out after 1200 ms");
		expect(elapsed).toBeLessThan(10_000);
	});

	it("is validated", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const tooSmall = await client.tool("pi", { prompt: "x", cwd: ws.dir, timeout_ms: 5 });
		const notNumber = await client.tool("pi", { prompt: "x", cwd: ws.dir, timeout_ms: "long" });
		const overCeiling = await client.tool("pi", { prompt: "x", cwd: ws.dir, timeout_ms: 999_999_999 });
		client.close();

		expect(tooSmall.isError).toBe(true);
		expect(tooSmall.text).toContain("at least 1000");
		expect(notNumber.isError).toBe(true);
		expect(overCeiling.isError).toBe(true);
		expect(overCeiling.text).toContain("ceiling");
	});

	it("also applies to pi_reply", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi_reply", {
			session: "11111111-1111-4111-8111-111111111111",
			prompt: "go",
			cwd: ws.dir,
			timeout_ms: 1100,
		});
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("timed out after 1100 ms");
		// The id it was given is echoed back, so the caller can keep using it.
		expect(res.text).toContain("11111111-1111-4111-8111-111111111111");
	});
});
