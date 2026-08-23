// What the caller gets back: pi's settled answer, aggregate stats, and nothing
// else from the transcript.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

async function run(env: Record<string, string>, args: Record<string, unknown> = {}, meta?: unknown) {
	const client = new Client({ ...ws.env, ...env }, ws.dir);
	await client.handshake();
	const res = await client.tool("pi", { prompt: "go", cwd: ws.dir, ...args }, meta);
	const notes = client.progressNotes();
	client.close();
	return { ...res, notes };
}

describe("answer selection", () => {
	it("returns the settled message, not mid-run narration", async () => {
		const res = await run({});
		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
		expect(res.text).not.toContain("NARRATION");
	});

	it("reports a session id for follow-ups", async () => {
		const res = await run({});
		expect(res.text).toMatch(/\[session: [0-9a-f-]{36}\]/);
	});

	it("parses a final event that ends at EOF without a newline", async () => {
		const res = await run({ FAKE_MODE: "no_newline" });
		expect(res.isError).toBe(false);
		expect(res.text).toContain("EOF TERMINATED ANSWER");
	});

	it("treats a settled but empty message as a failure, without promoting narration", async () => {
		const res = await run({ FAKE_MODE: "empty_final" });
		expect(res.isError).toBe(true);
		expect(res.text).not.toContain("NARRATION");
		expect(res.text).toMatch(/no answer text|no usable answer/);
	});

	it("blames the model, not the protocol, when a settled message is empty", async () => {
		// A well-formed stream where the model returned nothing. Reporting a contract
		// mismatch here sends the reader after the wrong bug.
		const res = await run({ FAKE_MODE: "empty_completion" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("the model returned no content");
		expect(res.text).not.toContain("did not match the expected");
		// The stats still say what arrived, so the claim is checkable.
		expect(res.text).toContain("assistant messages seen: 1");
	});

	it("never returns the raw transcript when the stream is not the expected contract", async () => {
		const res = await run({ FAKE_MODE: "garbage" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("did not match the expected");
		// The diagnostic describes the shape only — no transcript content.
		expect(res.text).not.toContain("not json");
	});
});

describe("stopReason is fail-closed", () => {
	it.each([
		["stop", false],
		["length", false],
		["error", true],
		["aborted", true],
		["deferred", true],
		["brand_new_reason", true],
	])("stopReason=%s → isError=%s", async (reason, expected) => {
		const res = await run({ FAKE_STOP: String(reason) });
		expect(res.isError).toBe(expected);
		// The answer is attached either way, so a caller can still see it.
		expect(res.text).toContain("FINAL ANSWER");
	});

	it("names the model output limit when the model was cut off", async () => {
		const res = await run({ FAKE_STOP: "length" });
		expect(res.text).toContain("hit model output limit");
	});
});

describe("stats line", () => {
	it("counts tool calls in total and per tool", async () => {
		const res = await run({});
		expect(res.text).toContain("1 tool call: write");
	});

	it("says so explicitly when no tools were used", async () => {
		const res = await run({ FAKE_MODE: "no_stop" });
		expect(res.text).toContain("no tool calls");
	});

	it("lists files pi wrote", async () => {
		const res = await run({});
		expect(res.text).toContain("pi wrote: note.md");
	});

	it("omits the written-files line when nothing was written", async () => {
		const res = await run({ FAKE_MODE: "no_stop" });
		expect(res.text).not.toContain("pi wrote:");
	});

	it("reports reasoning tokens and cost when pi reports them", async () => {
		const res = await run({});
		expect(res.text).toContain("think");
		expect(res.text).toContain("$0.0012");
	});

	it("stays compact for a multi-tool run", async () => {
		const res = await run({});
		// The whole response, answer included, is a few hundred characters.
		expect(res.text.length).toBeLessThan(600);
	});
});

describe("answer size", () => {
	it("is not truncated by default", async () => {
		const res = await run({ FAKE_MODE: "big", FAKE_SIZE: "200000" });
		expect((res.text.match(/X/g) ?? []).length).toBe(200_000);
		expect(res.text).not.toContain("truncated");
	});

	it("honours an explicit cap", async () => {
		const res = await run({ FAKE_MODE: "big", FAKE_SIZE: "200000", PI_MCP_MAX_OUTPUT: "5000" });
		expect((res.text.match(/X/g) ?? []).length).toBe(5_000);
		expect(res.text).toContain("truncated");
	});
});

describe("progress", () => {
	it("emits notifications when the client supplies a progress token", async () => {
		const res = await run({}, {}, { progressToken: "t1" });
		expect(res.notes.length).toBeGreaterThan(0);
		expect(res.notes.some((n) => n.startsWith("turn "))).toBe(true);
		expect(res.notes).toContain("running write");
	});

	it("sends none when the client did not ask for progress", async () => {
		const res = await run({});
		expect(res.notes).toEqual([]);
	});
});

describe("input validation", () => {
	it.each([
		["empty prompt", "pi", { prompt: "  " }, "`prompt` is required"],
		["relative cwd", "pi", { prompt: "x", cwd: "rel/path" }, "must be an absolute path"],
		["missing cwd", "pi", { prompt: "x", cwd: "/nope/does/not/exist" }, "does not exist"],
		["bad thinking level", "pi", { prompt: "x", thinking: "turbo" }, "invalid thinking level"],
		["non-string model", "pi", { prompt: "x", model: 5 }, "model must be a string"],
		["missing session", "pi_reply", { prompt: "x", session: "" }, "`session` is required"],
		["non-string search", "pi_models", { search: 5 }, "must be a string"],
	])("rejects %s", async (_name, tool, args, needle) => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool(tool as string, args);
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain(needle as string);
	});
});
