// Process lifecycle: timeouts, cancellation, shutdown, concurrency. The rule
// being enforced throughout is that no pi process outlives the request that
// started it.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sleep, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

// Test files run in parallel, so each spawned grandchild carries a tag unique to
// this file. Selecting on "sleep 120" alone would see other files' processes.
const CHILD_TAG = "pi-cli-mcp-lifecycle-child";

function survivors(): string {
	return spawnSync("pgrep", ["-f", CHILD_TAG], { encoding: "utf8" }).stdout.trim();
}

describe("timeout", () => {
	it("kills pi and reports the timeout", async () => {
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG, PI_MCP_TIMEOUT_MS: "1000" },
			ws.dir,
		);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("timed out");
	});
});

describe("exit status", () => {
	it("treats a non-zero exit as an error and names the code", async () => {
		const client = new Client({ ...ws.env, FAKE_EXIT: "3" }, ws.dir);
		await client.handshake();
		const res = await client.tool("pi", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("code 3");
	});
});

describe("cancellation", () => {
	it("kills the whole process tree, not just pi", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		const call = client.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: ws.dir } });
		await sleep(700);
		expect(survivors()).not.toBe("");

		client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: call.id, reason: "test" },
		});
		const res = (await call.promise).result;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("cancelled");

		await sleep(600);
		expect(survivors()).toBe("");
		client.close();
	});

	it("never starts pi when the call is cancelled while queued", async () => {
		// One slot, two calls: the second is still waiting when it is cancelled.
		const startedFile = join(ws.dir, "started.log");
		writeFileSync(startedFile, "");
		const client = new Client(
			{
				...ws.env,
				FAKE_MODE: "slow",
				FAKE_DELAY_MS: "1200",
				FAKE_STARTED_FILE: startedFile,
				PI_MCP_MAX_CONCURRENT: "1",
			},
			ws.dir,
		);
		await client.handshake();

		const first = client.request("tools/call", { name: "pi", arguments: { prompt: "one", cwd: ws.dir } });
		await sleep(200);
		const queued = client.request("tools/call", { name: "pi", arguments: { prompt: "two", cwd: ws.dir } });
		await sleep(150);
		client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: queued.id, reason: "test" },
		});

		const queuedRes = (await queued.promise).result;
		expect(queuedRes.isError).toBe(true);
		expect(queuedRes.content[0].text).toContain("cancelled");

		await first.promise;
		const starts = readFileSync(startedFile, "utf8").trim().split("\n").filter(Boolean);
		expect(starts).toHaveLength(1);
		client.close();
	});
});

describe("shutdown", () => {
	it("reaps running pi trees on stdin EOF", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		client.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: ws.dir } });
		await sleep(700);
		expect(survivors()).not.toBe("");

		// stdin EOF is how an MCP client says goodbye.
		client.child.stdin.end();
		await sleep(1500);
		expect(survivors()).toBe("");
		client.child.kill("SIGKILL");
	});

	it("reaps running pi trees on SIGTERM", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		client.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: ws.dir } });
		await sleep(700);
		expect(survivors()).not.toBe("");

		client.child.kill("SIGTERM");
		await sleep(1500);
		expect(survivors()).toBe("");
		client.child.kill("SIGKILL");
	});
});

describe("concurrency", () => {
	it("runs independent calls in parallel", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "slow", FAKE_DELAY_MS: "600" }, ws.dir);
		await client.handshake();
		const started = Date.now();
		await Promise.all(
			[0, 1, 2].map(
				() => client.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: ws.dir } }).promise,
			),
		);
		const elapsed = Date.now() - started;
		client.close();
		// Serialized would be ~1800ms.
		expect(elapsed).toBeLessThan(1500);
	});

	it("respects the concurrency cap", async () => {
		const startedFile = join(ws.dir, "cap.log");
		writeFileSync(startedFile, "");
		const client = new Client(
			{
				...ws.env,
				FAKE_MODE: "slow",
				FAKE_DELAY_MS: "500",
				FAKE_STARTED_FILE: startedFile,
				PI_MCP_MAX_CONCURRENT: "2",
			},
			ws.dir,
		);
		await client.handshake();
		const calls = [0, 1, 2, 3].map(
			() => client.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: ws.dir } }).promise,
		);
		await sleep(250);
		// Only the cap may have started so far.
		const midway = readFileSync(startedFile, "utf8").trim().split("\n").filter(Boolean);
		expect(midway.length).toBeLessThanOrEqual(2);
		await Promise.all(calls);
		const total = readFileSync(startedFile, "utf8").trim().split("\n").filter(Boolean);
		expect(total).toHaveLength(4);
		client.close();
	});
});
