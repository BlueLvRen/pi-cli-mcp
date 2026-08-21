// Session continuity, its persistence across server restarts, and the mutex that
// keeps two pi processes off one session file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

function stateEnv(name: string): Record<string, string> {
	return { ...ws.env, PI_MCP_STATE: join(ws.dir, `${name}.json`) };
}

describe("session continuity", () => {
	it("lists nothing before the first run", async () => {
		const client = new Client(stateEnv("empty"), ws.dir);
		await client.handshake();
		const res = await client.tool("pi_sessions");
		client.close();
		expect(res.text).toContain("No pi sessions");
	});

	it("lists a session after a run and survives a server restart", async () => {
		const env = stateEnv("restart");
		let id: string;
		{
			const client = new Client(env, ws.dir);
			await client.handshake();
			id = sessionIdOf((await client.tool("pi", { prompt: "go", cwd: ws.dir })).text);
			expect((await client.tool("pi_sessions")).text).toContain(id);
			client.close();
		}
		{
			// A fresh server process: pi owns the conversation on disk, we only need
			// to remember which directory it belongs to.
			const client = new Client(env, ws.dir);
			await client.handshake();
			expect((await client.tool("pi_sessions")).text).toContain(id);
			const reply = await client.tool("pi_reply", { session: id, prompt: "again" });
			expect(reply.text).not.toContain("no existing session");
			client.close();
		}
	});

	it("flags an unknown session instead of silently starting a new conversation", async () => {
		const client = new Client({ ...stateEnv("unknown"), FAKE_UNKNOWN_SESSION: "1" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi_reply", {
			session: "00000000-0000-4000-8000-000000000000",
			prompt: "x",
			cwd: ws.dir,
		});
		client.close();
		expect(res.text).toContain("no existing session");
	});
});

describe("remembered run options", () => {
	it("keeps the model and thinking level across a reply that omits them", async () => {
		const env = stateEnv("model");
		const stateFile = env.PI_MCP_STATE as string;
		const client = new Client(env, ws.dir);
		await client.handshake();
		const id = sessionIdOf(
			(await client.tool("pi", { prompt: "go", cwd: ws.dir, model: "fake/beta", thinking: "high" })).text,
		);
		// A reply without overrides must not erase what the session was started with.
		await client.tool("pi_reply", { session: id, prompt: "again" });
		client.close();

		const stored = JSON.parse(readFileSync(stateFile, "utf8")).sessions[id];
		expect(stored.model).toBe("fake/beta");
		expect(stored.thinking).toBe("high");
	});
});

describe("session mutex", () => {
	it("never lets two runs share one session", async () => {
		// The fake detects overlap itself via a lockfile: without the mutex the
		// second run finds the lock held and answers OVERLAP DETECTED. Asserting
		// only that both calls finish would pass even with the mutex removed.
		const client = new Client(
			{
				...stateEnv("overlap"),
				FAKE_MODE: "overlap",
				FAKE_LOCK_FILE: join(ws.dir, "overlap.lock"),
				FAKE_DELAY_MS: "400",
			},
			ws.dir,
		);
		await client.handshake();
		const id = sessionIdOf((await client.tool("pi", { prompt: "go", cwd: ws.dir })).text);

		const [a, b] = await Promise.all([
			client.request("tools/call", { name: "pi_reply", arguments: { session: id, prompt: "a" } }).promise,
			client.request("tools/call", { name: "pi_reply", arguments: { session: id, prompt: "b" } }).promise,
		]);
		client.close();

		const texts = [a.result?.content?.[0]?.text ?? "", b.result?.content?.[0]?.text ?? ""];
		expect(texts.every((t) => t.includes("EXCLUSIVE"))).toBe(true);
		expect(texts.some((t) => t.includes("OVERLAP DETECTED"))).toBe(false);
	});
});
