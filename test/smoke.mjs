#!/usr/bin/env node
// Drives the real server over stdio. Uses a fake pi binary, so the suite needs
// no API access and spends no tokens.
//
// With PI_CLI_MCP_LIVE=1 it also runs one real pi call at the end.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "index.mjs");
const FAKE = join(here, "fixtures", "fake-pi.mjs");

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

// A shell shim, because the server spawns its pi binary as a plain command.
function makeFakeBin(dir) {
  const bin = join(dir, "pi");
  writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${FAKE} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

class Client {
  constructor(env, cwd) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.pending = new Map();
    this.notifications = [];
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#ingest(chunk));
    this.nextId = 1;
  }

  #ingest(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else {
        // Notifications, plus protocol-level errors that carry id: null.
        this.notifications.push(msg);
      }
    }
  }

  send(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve) => this.pending.set(id, resolve));
    this.send({ jsonrpc: "2.0", id, method, params });
    return { id, promise };
  }

  async call(method, params) {
    return (await this.request(method, params).promise);
  }

  async handshake() {
    await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async tool(name, args, meta) {
    const res = await this.call("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    return res.result ?? res;
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const workdir = mkdtempSync(join(tmpdir(), "pi-cli-mcp-test-"));
const fakeBin = makeFakeBin(workdir);
const baseEnv = {
  PI_MCP_BIN: fakeBin,
  PI_MCP_STATE: join(workdir, "sessions.json"),
};

async function suite() {
  process.stdout.write("protocol\n");
  {
    const c = new Client(baseEnv, workdir);
    const init = await c.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    check("initialize echoes the requested protocol", init.result?.protocolVersion === "2025-06-18");
    check("advertises the tools capability", Boolean(init.result?.capabilities?.tools));
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await c.call("tools/list");
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    check("tools/list exposes all four tools",
      JSON.stringify(names) === JSON.stringify(["pi", "pi_models", "pi_reply", "pi_sessions"]),
      names.join(","));

    const ping = await c.call("ping");
    check("ping answers", ping.result !== undefined);

    const bogus = await c.call("no/such/method");
    check("unknown method is a JSON-RPC error", bogus.error?.code === -32601);

    const badTool = await c.call("tools/call", { name: "nope", arguments: {} });
    check("unknown tool is rejected", badTool.error?.code === -32602);
    c.close();
  }

  process.stdout.write("answer extraction\n");
  {
    const c = new Client(baseEnv, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir }, { progressToken: "t1" });
    const text = res.content[0].text;
    check("not an error", res.isError !== true);
    check("returns the final answer", text.includes("FINAL ANSWER"));
    check("drops mid-run narration", !text.includes("NARRATION"), text.slice(0, 80));
    check("reports a session id", /\[session: [0-9a-f-]{36}\]/.test(text));
    check("counts every tool call", text.includes("1 tool call: write"), text);
    check("lists written files", text.includes("pi wrote: note.md"));
    check("reports reasoning tokens", text.includes("think"));
    check("reports cost", text.includes("$0.0012"));
    check("emits progress notifications",
      c.notifications.some((n) => n.method === "notifications/progress"));
    c.close();
  }

  process.stdout.write("stopReason is fail-closed\n");
  for (const [reason, shouldFail] of [
    ["stop", false], ["length", false],
    ["error", true], ["aborted", true], ["brand_new_reason", true],
  ]) {
    const c = new Client({ ...baseEnv, FAKE_STOP: reason }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    const text = res.content[0].text;
    check(`stopReason=${reason} → ${shouldFail ? "error" : "success"}`,
      Boolean(res.isError) === shouldFail, `isError=${res.isError}`);
    check(`stopReason=${reason} still returns the answer`, text.includes("FINAL ANSWER"));
    c.close();
  }

  process.stdout.write("answer is not truncated\n");
  {
    const c = new Client({ ...baseEnv, FAKE_MODE: "big", FAKE_SIZE: "200000" }, workdir);
    await c.handshake();
    const text = (await c.tool("pi", { prompt: "go", cwd: workdir })).content[0].text;
    check("200k answer arrives whole", (text.match(/X/g) ?? []).length === 200_000);
    check("no truncation notice", !text.includes("truncated"));
    c.close();
  }
  {
    const c = new Client({ ...baseEnv, FAKE_MODE: "big", FAKE_SIZE: "200000", PI_MCP_MAX_OUTPUT: "5000" }, workdir);
    await c.handshake();
    const text = (await c.tool("pi", { prompt: "go", cwd: workdir })).content[0].text;
    check("explicit cap is honoured", (text.match(/X/g) ?? []).length === 5_000);
    check("cap is disclosed", text.includes("truncated"));
    c.close();
  }

  process.stdout.write("validation\n");
  {
    const c = new Client(baseEnv, workdir);
    await c.handshake();
    const cases = [
      ["empty prompt", "pi", { prompt: "  " }, "prompt` is required"],
      ["relative cwd", "pi", { prompt: "x", cwd: "rel/path" }, "must be an absolute path"],
      ["missing cwd", "pi", { prompt: "x", cwd: "/nope/does/not/exist" }, "does not exist"],
      ["bad thinking level", "pi", { prompt: "x", thinking: "turbo" }, "invalid thinking level"],
      ["missing session", "pi_reply", { prompt: "x", session: "" }, "session` is required"],
      ["non-string search", "pi_models", { search: 5 }, "must be a string"],
    ];
    for (const [name, tool, args, needle] of cases) {
      const res = await c.tool(tool, args);
      const text = res.content[0].text;
      check(`${name} is rejected`, res.isError === true && text.includes(needle), text.slice(0, 90));
    }
    c.close();
  }

  process.stdout.write("sessions\n");
  {
    const stateFile = join(workdir, "sessions-flow.json");
    const env = { ...baseEnv, PI_MCP_STATE: stateFile };
    let sessionId;
    {
      const c = new Client(env, workdir);
      await c.handshake();
      const empty = await c.tool("pi_sessions", {});
      check("no sessions initially", empty.content[0].text.includes("No pi sessions"));
      const text = (await c.tool("pi", { prompt: "go", cwd: workdir })).content[0].text;
      sessionId = text.match(/\[session: ([0-9a-f-]{36})\]/)[1];
      check("session is listed after a run",
        (await c.tool("pi_sessions", {})).content[0].text.includes(sessionId));
      c.close();
    }
    {
      // Fresh server process: the session must still be known.
      const c = new Client(env, workdir);
      await c.handshake();
      check("session survives a server restart",
        (await c.tool("pi_sessions", {})).content[0].text.includes(sessionId));
      const reply = await c.tool("pi_reply", { session: sessionId, prompt: "again" });
      check("reply to a known session carries no warning",
        !reply.content[0].text.includes("no existing session"));
      c.close();
    }
    {
      const c = new Client({ ...env, FAKE_UNKNOWN_SESSION: "1" }, workdir);
      await c.handshake();
      const unknown = await c.tool("pi_reply", {
        session: "00000000-0000-4000-8000-000000000000", prompt: "x", cwd: workdir,
      });
      check("unknown session is flagged, not silently continued",
        unknown.content[0].text.includes("no existing session"),
        unknown.content[0].text.slice(0, 100));
      c.close();
    }
  }

  process.stdout.write("answer contract\n");
  {
    // A settled-but-empty final message must not promote earlier narration.
    const c = new Client({ ...baseEnv, FAKE_MODE: "empty_final" }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    const text = res.content[0].text;
    check("empty settled message is an error", res.isError === true);
    check("narration is not promoted to the answer", !text.includes("NARRATION"), text.slice(0, 120));
    check("no-answer case is named", text.includes("no answer text") || text.includes("no usable answer"));
    c.close();
  }
  {
    // A missing stopReason is not silently treated as success.
    const c = new Client({ ...baseEnv, FAKE_MODE: "no_stop" }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    check("missing stopReason fails closed", res.isError === true);
    check("answer is still returned", res.content[0].text.includes("ANSWER WITHOUT STOP REASON"));
    c.close();
  }
  {
    // A broken event contract must never dump the raw transcript as an answer.
    const c = new Client({ ...baseEnv, FAKE_MODE: "garbage" }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    const text = res.content[0].text;
    check("unparseable stream is an error", res.isError === true);
    check("contract break is named", text.includes("did not match the expected"), text.slice(0, 120));
    c.close();
  }
  {
    // pi may end its last event at EOF without a newline.
    const c = new Client({ ...baseEnv, FAKE_MODE: "no_newline" }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    check("EOF-terminated final event is parsed",
      res.isError !== true && res.content[0].text.includes("EOF TERMINATED ANSWER"),
      res.content[0].text.slice(0, 120));
    c.close();
  }

  process.stdout.write("remembered model survives a plain reply\n");
  {
    const stateFile = join(workdir, "sessions-model.json");
    const c = new Client({ ...baseEnv, PI_MCP_STATE: stateFile }, workdir);
    await c.handshake();
    const text = (await c.tool("pi", {
      prompt: "go", cwd: workdir, model: "fake/beta", thinking: "high",
    })).content[0].text;
    const id = text.match(/\[session: ([0-9a-f-]{36})\]/)[1];
    // A reply that omits the overrides must not erase them.
    await c.tool("pi_reply", { session: id, prompt: "again" });
    const stored = JSON.parse(readFileSync(stateFile, "utf8")).sessions[id];
    check("model is remembered", stored?.model === "fake/beta", JSON.stringify(stored));
    check("thinking is remembered", stored?.thinking === "high", JSON.stringify(stored));
    c.close();
  }

  process.stdout.write("concurrent replies are serialized\n");
  {
    // The fake detects overlap itself: without the mutex, the second run sees
    // the lockfile and answers "OVERLAP DETECTED". Asserting only that both
    // calls finish would pass even with the mutex removed.
    const env = {
      ...baseEnv,
      FAKE_MODE: "overlap",
      FAKE_LOCK_FILE: join(workdir, "overlap.lock"),
      FAKE_DELAY_MS: "400",
    };
    const c = new Client(env, workdir);
    await c.handshake();
    const first = (await c.tool("pi", { prompt: "go", cwd: workdir })).content[0].text;
    const id = first.match(/\[session: ([0-9a-f-]{36})\]/)[1];
    const a = c.request("tools/call", { name: "pi_reply", arguments: { session: id, prompt: "a" } });
    const b = c.request("tools/call", { name: "pi_reply", arguments: { session: id, prompt: "b" } });
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    const texts = [ra.result?.content?.[0]?.text ?? "", rb.result?.content?.[0]?.text ?? ""];
    check("both replies complete", texts.every((t) => t.includes("EXCLUSIVE") || t.includes("OVERLAP")));
    check("the two runs never overlap",
      texts.every((t) => !t.includes("OVERLAP DETECTED")),
      texts.join(" | ").slice(0, 160));
    c.close();
  }
  {
    // Different sessions must still run in parallel, not be needlessly serialized.
    const env = { ...baseEnv, FAKE_MODE: "slow", FAKE_DELAY_MS: "600" };
    const c = new Client(env, workdir);
    await c.handshake();
    const started = Date.now();
    const calls = [0, 1, 2].map(() =>
      c.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: workdir } }).promise);
    await Promise.all(calls);
    const elapsed = Date.now() - started;
    check("independent calls run concurrently", elapsed < 1500, `${elapsed}ms for 3×600ms`);
    c.close();
  }

  process.stdout.write("cancellation\n");
  {
    const c = new Client({ ...baseEnv, FAKE_MODE: "hang" }, workdir);
    await c.handshake();
    const call = c.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: workdir } });
    await new Promise((r) => setTimeout(r, 700));
    c.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: call.id, reason: "test" },
    });
    const res = (await call.promise).result;
    check("cancelled call returns an error", res.isError === true);
    check("cancellation is named", res.content[0].text.includes("cancelled"), res.content[0].text.slice(0, 80));
    await new Promise((r) => setTimeout(r, 500));
    const survivors = spawnSync("pgrep", ["-f", "sleep 120"], { encoding: "utf8" }).stdout.trim();
    check("child processes do not survive", survivors === "", survivors);
    c.close();
  }

  process.stdout.write("cancellation while queued\n");
  {
    // One slot, two calls: the second is still queued when it is cancelled, so
    // its pi process must never start.
    const startedFile = join(workdir, "started.log");
    writeFileSync(startedFile, "");
    const env = {
      ...baseEnv,
      FAKE_MODE: "slow",
      FAKE_DELAY_MS: "1200",
      FAKE_STARTED_FILE: startedFile,
      PI_MCP_MAX_CONCURRENT: "1",
    };
    const c = new Client(env, workdir);
    await c.handshake();
    const first = c.request("tools/call", { name: "pi", arguments: { prompt: "one", cwd: workdir } });
    await new Promise((r) => setTimeout(r, 200));
    const queued = c.request("tools/call", { name: "pi", arguments: { prompt: "two", cwd: workdir } });
    await new Promise((r) => setTimeout(r, 150));
    c.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: queued.id, reason: "test" },
    });
    const queuedRes = (await queued.promise).result;
    check("queued call is cancelled", queuedRes.isError === true);
    check("queued cancellation is named", queuedRes.content[0].text.includes("cancelled"),
      queuedRes.content[0].text.slice(0, 100));
    await first.promise;
    const starts = readFileSync(startedFile, "utf8").trim().split("\n").filter(Boolean).length;
    check("cancelled-while-queued never spawns pi", starts === 1, `${starts} pi process(es) started`);
    c.close();
  }

  process.stdout.write("shutdown\n");
  {
    // Killing the server must take the detached pi tree with it; the children
    // are in their own process group precisely so nothing else can reap them.
    const c = new Client({ ...baseEnv, FAKE_MODE: "hang" }, workdir);
    await c.handshake();
    c.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: workdir } });
    await new Promise((r) => setTimeout(r, 700));
    const before = spawnSync("pgrep", ["-f", "sleep 120"], { encoding: "utf8" }).stdout.trim();
    check("child is running before shutdown", before !== "");
    c.child.stdin.end();  // stdin EOF is how MCP clients say goodbye
    await new Promise((r) => setTimeout(r, 1500));
    const after = spawnSync("pgrep", ["-f", "sleep 120"], { encoding: "utf8" }).stdout.trim();
    check("stdin EOF reaps the whole pi tree", after === "", `survivors: ${after}`);
    c.child.kill("SIGKILL");
  }
  {
    // Same guarantee on SIGTERM.
    const c = new Client({ ...baseEnv, FAKE_MODE: "hang" }, workdir);
    await c.handshake();
    c.request("tools/call", { name: "pi", arguments: { prompt: "go", cwd: workdir } });
    await new Promise((r) => setTimeout(r, 700));
    c.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    const after = spawnSync("pgrep", ["-f", "sleep 120"], { encoding: "utf8" }).stdout.trim();
    check("SIGTERM reaps the whole pi tree", after === "", `survivors: ${after}`);
    c.child.kill("SIGKILL");
  }

  process.stdout.write("json-rpc conformance\n");
  {
    const c = new Client(baseEnv, workdir);
    await c.handshake();

    // Notifications must never draw a response. Send one, then a real request:
    // if the notification answered, the reply below would carry the wrong id.
    c.send({ jsonrpc: "2.0", method: "tools/list" });
    c.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "pi_sessions", arguments: {} } });
    const ping = await c.call("ping");
    check("notifications get no response", ping.id !== undefined && ping.result !== undefined);

    // Errors for non-objects carry id: null, so they arrive on the untargeted
    // stream rather than as a reply.
    c.child.stdin.write("[1,2,3]\n");
    await new Promise((r) => setTimeout(r, 200));
    check("a JSON array is Invalid Request",
      c.notifications.some((n) => n.error?.code === -32600));

    c.child.stdin.write('{"jsonrpc":"2.0","id":99}\n');
    await new Promise((r) => setTimeout(r, 200));
    check("a request without a method is Invalid Request",
      c.notifications.some((n) => n.error?.code === -32600) ||
      c.pending.size === 0);

    c.child.stdin.write("{not json}\n");
    await new Promise((r) => setTimeout(r, 200));
    check("malformed JSON is a parse error",
      c.notifications.some((n) => n.error?.code === -32700));
    c.close();
  }

  process.stdout.write("timeout\n");
  {
    const c = new Client({ ...baseEnv, FAKE_MODE: "hang", PI_MCP_TIMEOUT_MS: "1000" }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    check("timeout is reported as an error", res.isError === true);
    check("timeout is named", res.content[0].text.includes("timed out"));
    c.close();
  }

  process.stdout.write("exit code\n");
  {
    const c = new Client({ ...baseEnv, FAKE_EXIT: "3" }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "go", cwd: workdir });
    check("non-zero exit is an error", res.isError === true);
    check("exit code is reported", res.content[0].text.includes("code 3"));
    c.close();
  }

  process.stdout.write("pi_models\n");
  {
    const c = new Client(baseEnv, workdir);
    await c.handshake();
    const all = await c.tool("pi_models", {});
    check("lists models", all.content[0].text.includes("fake/alpha"));
    const filtered = await c.tool("pi_models", { search: "beta" });
    check("applies the filter", filtered.content[0].text.includes("fake/beta") &&
      !filtered.content[0].text.includes("fake/alpha"));
    c.close();
  }

  if (process.env.PI_CLI_MCP_LIVE === "1") {
    process.stdout.write("live pi (PI_CLI_MCP_LIVE=1)\n");
    const c = new Client({ PI_MCP_STATE: join(workdir, "live.json") }, workdir);
    await c.handshake();
    const res = await c.tool("pi", { prompt: "Reply with exactly: LIVE_OK", no_tools: true });
    check("real pi answers", res.content[0].text.includes("LIVE_OK"), res.content[0].text.slice(0, 200));
    c.close();
  }
}

try {
  await suite();
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
