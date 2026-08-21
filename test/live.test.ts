// Runs against the real pi binary. Opt-in, because it spends tokens and needs a
// working provider: PI_CLI_MCP_LIVE=1 npm test
//
// Its second purpose is a runtime counterpart to test/pi-contract.test-d.ts: the
// type test proves our view of pi's contract matches pi's declared types, this
// one proves the installed pi actually behaves that way.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, sessionIdOf } from "./helpers/client.ts";

const live = process.env.PI_CLI_MCP_LIVE === "1";
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-cli-mcp-live-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(live)("real pi", () => {
	it("answers a prompt with no tools", async () => {
		const client = new Client({ PI_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "Reply with exactly: LIVE_OK", no_tools: true });
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("LIVE_OK");
		// The stats line proves the json event stream was understood.
		expect(res.text).toMatch(/\npi: .+ · \d+ turn/);
	});

	it("keeps context across a reply", async () => {
		const client = new Client({ PI_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const first = await client.tool("pi", {
			prompt: "Remember the codeword ZULU-9. Reply with exactly: ZULU-9",
			no_tools: true,
		});
		const id = sessionIdOf(first.text);
		const reply = await client.tool("pi_reply", {
			session: id,
			prompt: "What codeword did I give you? Reply with only it.",
		});
		client.close();
		expect(reply.isError).toBe(false);
		expect(reply.text).toContain("ZULU-9");
	});

	it("lists real models", async () => {
		const client = new Client({ PI_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("pi_models");
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("provider");
	});

	it("uses only stop reasons we classify", async () => {
		// A live guard against pi introducing a reason our partition does not know:
		// an unrecognized one would surface as an error with that word in the text.
		const client = new Client({ PI_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "Reply with exactly: OK", no_tools: true });
		client.close();
		expect(res.text).not.toContain("unrecognized stopReason");
	});
});
