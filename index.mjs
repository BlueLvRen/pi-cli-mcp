#!/usr/bin/env node
// Minimal stdio MCP server that exposes the locally installed `pi` CLI
// (@earendil-works/pi-coding-agent) as a delegatable sub-agent.
//
// Deliberately dependency-free: it speaks newline-delimited JSON-RPC 2.0
// directly and shells out to whatever `pi` is on PATH, so it never drifts from
// the pi version you have installed and always inherits your ~/.pi/agent
// settings (provider, models, extensions, thinking level).
//
// Design notes vs. pandysp/pi-mcp-server (which embeds an old pi fork):
//   - process-per-call, so pi's own session files are the source of truth and
//     follow-ups survive a restart of this server;
//   - pi runs with `--mode json`, so we get turns, tool calls, usage and cost
//     instead of scraping plain text;
//   - per-session mutex, because two concurrent replies would corrupt one
//     session file;
//   - MCP cancellation kills the child (SIGTERM, then SIGKILL).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PI_BIN = process.env.PI_MCP_BIN ?? "pi";
// Optional command prefix, e.g. PI_MCP_WRAP="sandbox-exec -f /path/profile.sb".
// Lets you jail pi without this server knowing anything about the sandbox.
const PI_WRAP = (process.env.PI_MCP_WRAP ?? "").trim();
const TIMEOUT_MS = numEnv("PI_MCP_TIMEOUT_MS", 1_800_000, 1_000);
const KILL_GRACE_MS = numEnv("PI_MCP_KILL_GRACE_MS", 5_000, 0);
// The answer is what the caller asked for, so it is NOT truncated by default:
// if pi produced it, it goes to the caller in full. Set PI_MCP_MAX_OUTPUT to opt
// into a cap. The only backstop is MAX_CAPTURE below, which bounds the read
// buffer so a runaway stream cannot exhaust memory — a process guard, not an
// editorial limit on the answer.
const MAX_OUTPUT = process.env.PI_MCP_MAX_OUTPUT
  ? numEnv("PI_MCP_MAX_OUTPUT", Infinity, 1_000)
  : Infinity;
const STDERR_LIMIT = numEnv("PI_MCP_STDERR_LIMIT", 1_500, 200);
// Bounds on a single unterminated line: one from pi's event stream, one from the
// client's JSON-RPC stream. Without them a stream that never sends a newline
// grows until the process dies, taking every pending response with it.
const MAX_LINE = numEnv("PI_MCP_MAX_LINE", 8_000_000, 100_000);
const MAX_FRAME = numEnv("PI_MCP_MAX_FRAME", 8_000_000, 100_000);
const MAX_CAPTURE = numEnv("PI_MCP_MAX_CAPTURE", 16_000_000, 100_000);
const MAX_SESSIONS = numEnv("PI_MCP_MAX_SESSIONS", 200, 1);
const MAX_CONCURRENT = numEnv("PI_MCP_MAX_CONCURRENT", 4, 1);
const STATE_FILE =
  process.env.PI_MCP_STATE ?? join(homedir(), ".local", "state", "pi-mcp", "sessions.json");
const DEFAULT_MODEL = process.env.PI_MCP_MODEL ?? null;
const DEFAULT_THINKING = process.env.PI_MCP_THINKING ?? null;
const MAX_PROMPT = 2_000_000;
// pi has no `--` separator and argv has an OS size limit, so long or
// dash-leading prompts are handed over as an `@file` attachment.
const ARGV_PROMPT_LIMIT = 100_000;

const SERVER_INFO = { name: "pi", version: "0.2.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL = "2025-06-18";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function numEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    process.stderr.write(`pi-mcp: ignoring invalid ${name}=${raw}, using ${fallback}\n`);
    return fallback;
  }
  return value;
}

// --- session bookkeeping ---------------------------------------------------
// pi owns the conversation on disk (`--session-id`); we only remember which
// directory a session belongs to, so `pi_reply` resumes in the right project.

const sessions = new Map(); // id -> { cwd, lastAccessed, model?, thinking? }

function loadSessions() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.sessions !== "object") return;
    for (const [id, entry] of Object.entries(parsed.sessions)) {
      if (typeof entry?.cwd === "string") {
        sessions.set(id, {
          cwd: entry.cwd,
          lastAccessed: Number(entry.lastAccessed) || 0,
          model: typeof entry.model === "string" ? entry.model : undefined,
          thinking: typeof entry.thinking === "string" ? entry.thinking : undefined,
        });
      }
    }
    pruneSessions();
  } catch {
    // No state yet, or it is unreadable — start empty rather than fail.
  }
}

function pruneSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const ordered = [...sessions.entries()].sort(
    (a, b) => (a[1].lastAccessed || 0) - (b[1].lastAccessed || 0),
  );
  for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
}

// Re-read before writing: another server process may own sessions this one has
// never seen, and a blind snapshot write would delete them. tmp+rename only
// buys atomicity of a single write, not read-modify-write safety.
function saveSessions() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const merged = new Map();
    try {
      const onDisk = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (onDisk?.version === 1 && onDisk.sessions && typeof onDisk.sessions === "object") {
        for (const [id, entry] of Object.entries(onDisk.sessions)) {
          if (typeof entry?.cwd === "string") merged.set(id, entry);
        }
      }
    } catch {
      // No readable state on disk — our snapshot is the whole truth.
    }
    // Ours wins per id: this process just observed those runs.
    for (const [id, entry] of sessions) merged.set(id, entry);

    const ordered = [...merged.entries()].sort(
      (a, b) => (b[1].lastAccessed || 0) - (a[1].lastAccessed || 0),
    );
    const payload = {
      version: 1,
      sessions: Object.fromEntries(ordered.slice(0, MAX_SESSIONS)),
    };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    process.stderr.write(`pi-mcp: could not persist sessions: ${err.message}\n`);
  }
}

function rememberSession(id, cwd, extra = {}) {
  const prev = sessions.get(id) ?? {};
  // Only overwrite keys that were actually supplied: spreading `{model:
  // undefined}` over the previous entry would erase a remembered choice, so the
  // next reply would silently fall back to the default model.
  const next = { ...prev, cwd, lastAccessed: Date.now() };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) next[key] = value;
  }
  sessions.set(id, next);
  pruneSessions();
  saveSessions();
}

// Per-session mutex: two pi processes writing one session file would corrupt it.
// Process-local only — see README for the cross-process caveat.
const sessionLocks = new Map();

async function withSessionLock(id, fn) {
  const previous = sessionLocks.get(id)?.tail ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  // Store a handle whose identity we can compare later. Storing
  // `previous.then(...)` and comparing against `current` never matches, which
  // used to leak one map entry per distinct session id.
  const handle = { tail: previous.then(() => current) };
  sessionLocks.set(id, handle);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry once we are the tail, so the map does not grow forever.
    Promise.resolve().then(() => {
      if (sessionLocks.get(id) === handle) sessionLocks.delete(id);
    });
  }
}

// Global concurrency cap: pi runs are heavy, and the client may fan out.
let running = 0;
const waiting = [];

async function withSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

// --- tool schemas ---------------------------------------------------------

const SHARED_PROPS = {
  model: {
    type: "string",
    description:
      "Model pattern or id, e.g. 'bifrost/minimax/MiniMax-M3', 'sonnet', 'provider/id:thinking'. " +
      "Defaults to your pi settings.",
  },
  thinking: {
    type: "string",
    enum: THINKING_LEVELS,
    description: "Thinking level. Defaults to your pi settings.",
  },
};

const TOOLS = [
  {
    name: "pi",
    description:
      "Delegate a task to the local pi agent — a separate CLI coding agent with its own " +
      "read/bash/edit/write tools and its own context window. Runs non-interactively and returns " +
      "pi's final answer prefixed with [session: <id>] for follow-ups via pi_reply.\n" +
      "Good for: a second opinion from a different model, work you want kept out of this context, " +
      "or parallel investigation.\n" +
      "Caution: pi has no permission system. With its default tools it can edit files and run " +
      "shell commands as your user inside `cwd`. Pass `tools` or `no_tools` to restrict it.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The task for pi. Must be self-contained — pi cannot see this conversation. State the " +
            "files, the goal, and the expected output format.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute working directory. Defaults to this server's cwd. pi reads AGENTS.md / " +
            "CLAUDE.md from here.",
        },
        ...SHARED_PROPS,
        tools: {
          type: "string",
          description:
            "Comma-separated allowlist of pi tool names, e.g. 'read,grep,ls' for a read-only run. " +
            "Omit to keep pi's default set (includes bash/edit/write).",
        },
        no_tools: {
          type: "boolean",
          description: "Disable all pi tools — pure reasoning over the prompt text.",
        },
        system_prompt_append: {
          type: "string",
          description: "Extra text appended to pi's system prompt for this run.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_reply",
    description:
      "Continue an existing pi session. Pass the id returned as [session: <id>]. pi still has the " +
      "prior turns, so the follow-up can be short. Sessions live in pi's own session files and " +
      "survive restarts of this server.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id from a previous pi call." },
        prompt: { type: "string", description: "Follow-up message." },
        cwd: {
          type: "string",
          description: "Override the working directory. Defaults to where the session started.",
        },
        ...SHARED_PROPS,
      },
      required: ["session", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "pi_models",
    description:
      "List the models pi can actually reach, as a table of provider, model id, context window, " +
      "max output, thinking and image support. Read from the live catalog, so it reflects what is " +
      "configured right now rather than any documented list. Use it to pick a value for the " +
      "`model` argument of `pi`.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional fuzzy filter, e.g. 'glm', 'deepseek', 'minimax'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pi_sessions",
    description:
      "List pi sessions started through this server, newest first, with their working directory. " +
      "Use it to find an id for pi_reply when it has scrolled out of context.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// --- running pi -----------------------------------------------------------

function clip(text) {
  if (!Number.isFinite(MAX_OUTPUT) || text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n\n[pi-mcp: truncated at ${MAX_OUTPUT} of ${text.length} chars]`;
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_CAPTURE) return current;
  return current + chunk.slice(0, MAX_CAPTURE - current.length);
}

// Returns the argv tail carrying the prompt, plus cleanup for any temp file.
function promptArgs(prompt) {
  if (!prompt.startsWith("-") && prompt.length <= ARGV_PROMPT_LIMIT) {
    return { args: [prompt], cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, prompt, { mode: 0o600 });
  return {
    args: [`@${file}`, "Your task is the full contents of the attached file. Follow it exactly."],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function resolveCwd(requested) {
  if (!requested) return process.cwd();
  if (!requested.startsWith("/")) throw new Error(`cwd must be an absolute path: ${requested}`);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${requested}`);
  }
  return requested;
}

function commonArgs({ model, thinking, tools, no_tools, system_prompt_append }) {
  const args = [];
  const chosenModel = model ?? DEFAULT_MODEL;
  const chosenThinking = thinking ?? DEFAULT_THINKING;
  if (chosenThinking && !THINKING_LEVELS.includes(chosenThinking)) {
    throw new Error(`invalid thinking level "${chosenThinking}"; expected one of ${THINKING_LEVELS.join(", ")}`);
  }
  if (chosenModel) args.push("--model", chosenModel);
  if (chosenThinking) args.push("--thinking", chosenThinking);
  if (no_tools) args.push("--no-tools");
  else if (tools) args.push("--tools", tools);
  if (system_prompt_append) args.push("--append-system-prompt", system_prompt_append);
  return args;
}

function buildCommand(args) {
  if (!PI_WRAP) return { command: PI_BIN, argv: args };
  const parts = PI_WRAP.split(/\s+/);
  return { command: parts[0], argv: [...parts.slice(1), PI_BIN, ...args] };
}

// Live children, so shutdown can take their whole process groups with it.
// Detached children do not die with this process on their own.
const liveTrees = new Set();

function killAllTrees(signal) {
  for (const tree of [...liveTrees]) tree(signal);
}

// Runs pi, streaming `--mode json` events to onEvent. Resolves with the raw
// capture plus exit status; never rejects.
function runPi(args, cwd, { onEvent, token } = {}) {
  return new Promise((resolve) => {
    // Cancelled while queued for a slot or a session lock: never start pi.
    if (token?.cancelled) {
      resolve({ code: -1, stdout: "", stderr: "", cancelled: true });
      return;
    }

    const { command, argv } = buildCommand(args);
    let child;
    try {
      // `detached` puts pi in its own process group so a timeout or cancel can
      // kill the whole tree. Without it, anything pi spawned (a `sleep`, a test
      // runner, a dev server) survives as an orphan when pi does not forward the
      // signal itself.
      child = spawn(command, argv, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: true,
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: `failed to spawn ${command}: ${err.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let cancelled = false;
    let killTimer;

    // Signal the whole process group; fall back to the single child if the group
    // is already gone (ESRCH) or the platform refuses the negative pid.
    const signalTree = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already dead — nothing to do.
        }
      }
    };

    const stop = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "cancelled") cancelled = true;
      signalTree("SIGTERM");
      killTimer ??= setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
    };

    liveTrees.add(signalTree);
    const timer = setTimeout(() => stop("timeout"), TIMEOUT_MS);
    const unsubscribe = token?.subscribe(() => stop("cancelled")) ?? (() => {});

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || !onEvent) return;
      try {
        onEvent(JSON.parse(trimmed));
      } catch {
        // Not a JSON event line — the raw capture keeps it for diagnostics.
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk);
      if (!onEvent) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      // A single unterminated line must not grow without bound; MAX_CAPTURE
      // guards the transcript copy, not the line being assembled here.
      if (pending.length > MAX_LINE) {
        process.stderr.write(
          `pi-mcp: dropping an over-long event line (${pending.length} > ${MAX_LINE} chars)\n`,
        );
        pending = "";
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });

    const finish = (result) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      liveTrees.delete(signalTree);
      unsubscribe();
      // pi may end its last event with EOF instead of a newline; without this
      // the final answer would be missed and the run would look contract-broken.
      if (pending) {
        consumeLine(pending);
        pending = "";
      }
      resolve(result);
    };

    child.on("error", (err) => {
      finish({ code: -1, stdout, stderr: `${stderr}\n${command}: ${err.message}`.trim() });
    });
    child.on("close", (code) => {
      finish({ code: code ?? -1, stdout, stderr, timedOut, cancelled });
    });
  });
}

// --- pi json event accumulator -------------------------------------------

function newAccumulator() {
  return {
    // One entry per assistant message. "The answer" is defined by stopReason
    // (see finalAnswer), not by position or by the last text block.
    messages: [],
    toolCalls: [],
    openToolCalls: 0,
    writtenFiles: [],
    turns: 0,
    usage: { input: 0, output: 0, reasoning: 0, cost: 0 },
    model: null,
    provider: null,
    retries: 0,
    lastStopReason: null,
  };
}

// Tools whose target path is a side effect worth surfacing in the summary.
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch", "create"]);

// pi's stopReason vocabulary. `toolUse` means "this message is a step, more is
// coming"; the rest are terminal. Anything outside this set is treated as a
// failure rather than normalized into success — an added upstream value must not
// silently pass as a good answer. (Same fail-closed rule as niwa's pi adapter.)
const STOP_OK = new Set(["stop", "length"]);
const STOP_STEP = "toolUse";
const STOP_BAD = new Set(["error", "aborted"]);

function accumulate(acc, event) {
  switch (event?.type) {
    case "session":
      if (typeof event.id === "string") acc.sessionIdFromPi = event.id;
      return null;
    case "turn_start":
      acc.turns += 1;
      return `turn ${acc.turns}`;
    case "tool_execution_start": {
      const name = event.toolName ?? event.tool ?? "tool";
      return `running ${name}`;
    }
    case "tool_execution_end":
      if (acc.openToolCalls > 0) acc.openToolCalls -= 1;
      return null;
    case "auto_retry_start":
      acc.retries += 1;
      return `retrying (${event.attempt ?? acc.retries})`;
    case "auto_compaction_start":
      return "compacting context";
    case "message_end": {
      const msg = event.message;
      if (msg?.role !== "assistant") return null;
      acc.model ??= msg.model ?? null;
      acc.provider ??= msg.provider ?? null;
      const usage = msg.usage;
      if (usage) {
        // Summed across turns: every turn is a separate billed request, so this
        // is spend, not context size.
        acc.usage.input += usage.input ?? 0;
        acc.usage.output += usage.output ?? 0;
        acc.usage.reasoning += usage.reasoning ?? 0;
        acc.usage.cost += usage.cost?.total ?? 0;
      }
      if (typeof msg.stopReason === "string") acc.lastStopReason = msg.stopReason;

      const texts = [];
      for (const block of msg.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          texts.push(block.text.trim());
        } else if (block?.type === "toolCall" && block.name) {
          acc.toolCalls.push(block.name);
          acc.openToolCalls += 1;
          const path = block.arguments?.path ?? block.arguments?.file_path;
          if (WRITE_TOOLS.has(block.name) && typeof path === "string") {
            if (!acc.writtenFiles.includes(path)) acc.writtenFiles.push(path);
          }
        }
      }
      acc.messages.push({ text: texts.join("\n\n"), stopReason: msg.stopReason ?? null });
      return null;
    }
    default:
      return null;
  }
}

// "The answer" is the last assistant message that settled — the last one whose
// stopReason is not `toolUse`, which is how pi marks tool-call steps. Selection
// looks at every message, empty ones included: if the settled message carries no
// text, that is a broken run, not a licence to return an earlier preamble as
// though it were the answer.
//
// Returns { text, stopReason, source } so the caller validates the stopReason of
// the message it is actually returning, rather than whichever came last.
//   source "settled"  — a message settled and had text (the normal case)
//   source "cut-off"  — nothing settled; best available text from the last step
//   source "none"     — no assistant text at all
function selectAnswer(acc) {
  for (let i = acc.messages.length - 1; i >= 0; i -= 1) {
    const msg = acc.messages[i];
    if (msg.stopReason === STOP_STEP) continue;
    if (msg.text) return { text: msg.text, stopReason: msg.stopReason, source: "settled" };
    // A settled but empty message: report it rather than reaching further back.
    return { text: null, stopReason: msg.stopReason, source: "none" };
  }
  const lastWithText = [...acc.messages].reverse().find((m) => m.text);
  if (lastWithText) {
    return { text: lastWithText.text, stopReason: lastWithText.stopReason, source: "cut-off" };
  }
  return { text: null, stopReason: acc.lastStopReason, source: "none" };
}

// Fail-closed: anything other than a known-good terminal reason is a failure,
// including a missing stopReason on the message being returned.
function answerProblem(answer) {
  if (answer.source === "none") {
    return answer.stopReason
      ? `pi settled with stopReason=${answer.stopReason} but produced no answer text`
      : "pi produced no assistant text";
  }
  if (answer.source === "cut-off") {
    return "pi never settled a message — returning the last text it produced";
  }
  const reason = answer.stopReason;
  if (reason === null || reason === undefined) {
    return "pi settled without reporting a stopReason";
  }
  if (STOP_OK.has(reason)) return null;
  if (STOP_BAD.has(reason)) return `pi stopped with stopReason=${reason}`;
  return `pi returned an unrecognized stopReason=${reason}`;
}

function compactTokens(n) {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

// One or two short lines: aggregate stats only, plus explicit file side effects.
function summarize(acc, elapsedMs) {
  const bits = [];
  const model = acc.provider && acc.model ? `${acc.provider}/${acc.model}` : acc.model;
  if (model) bits.push(model);
  if (acc.turns) bits.push(`${acc.turns} turn${acc.turns === 1 ? "" : "s"}`);

  if (acc.toolCalls.length) {
    const counts = new Map();
    for (const name of acc.toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = ranked.slice(0, 8).map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
    if (ranked.length > 8) shown.push(`+${ranked.length - 8} more`);
    const total = acc.toolCalls.length;
    bits.push(`${total} tool call${total === 1 ? "" : "s"}: ${shown.join(", ")}`);
  } else {
    bits.push("no tool calls");
  }

  if (acc.usage.input || acc.usage.output) {
    const tokens = `${compactTokens(acc.usage.input)} in / ${compactTokens(acc.usage.output)} out`;
    bits.push(acc.usage.reasoning ? `${tokens} (${compactTokens(acc.usage.reasoning)} think)` : tokens);
  }
  if (acc.usage.cost > 0) bits.push(`$${acc.usage.cost.toFixed(4)}`);
  if (acc.retries) bits.push(`${acc.retries} retr${acc.retries === 1 ? "y" : "ies"}`);
  if (acc.lastStopReason === "length") bits.push("hit model output limit");
  if (acc.openToolCalls > 0) bits.push(`${acc.openToolCalls} tool call(s) never finished`);
  bits.push(`${(elapsedMs / 1000).toFixed(1)}s`);

  const lines = [`pi: ${bits.join(" · ")}`];
  if (acc.writtenFiles.length) {
    const shown = acc.writtenFiles.slice(0, 12).join(", ");
    const rest = acc.writtenFiles.length - 12;
    lines.push(`pi wrote: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`);
  }
  return lines.join("\n");
}

// pi announces a fresh session id on stderr; that is expected here, not a warning.
const NOISE = [/^Warning: No project session found with id .*creating a new session/i];

function usefulStderr(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.trim() && !NOISE.some((re) => re.test(line.trim())))
    .join("\n")
    .trim();
}

// stderr is diagnostics, not the deliverable — keep only the tail, where the
// actual error lives, and keep it small so it cannot dominate the response.
function tailStderr(stderr) {
  const text = usefulStderr(stderr);
  if (text.length <= STDERR_LIMIT) return text;
  return `[…earlier stderr omitted]\n${text.slice(-STDERR_LIMIT)}`;
}

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function describeFailure(result, acc) {
  const head = result.cancelled
    ? "pi was cancelled and the process was killed."
    : result.timedOut
      ? `pi timed out after ${TIMEOUT_MS} ms and was killed.`
      : `pi exited with code ${result.code}.`;
  const answer = acc ? selectAnswer(acc).text : null;
  const partial = answer ? `\n\npartial answer:\n${clip(answer)}` : "";
  const err = tailStderr(result.stderr ?? "");
  return `${head}${partial}${err ? `\n\nstderr:\n${err}` : ""}`;
}

// --- tool implementations -------------------------------------------------

async function invokePi({ args, cwd, progress, token }) {
  const acc = newAccumulator();
  const started = Date.now();
  const result = await runPi(args, cwd, {
    token,
    onEvent: (event) => {
      const note = accumulate(acc, event);
      if (note && progress) progress(note);
    },
  });
  return { acc, result, elapsedMs: Date.now() - started };
}

function renderSuccess(acc, result, elapsedMs, prefix) {
  const answer = selectAnswer(acc);
  const problem = answerProblem(answer);
  const warnings = tailStderr(result.stderr ?? "");
  const parts = [];
  if (prefix) parts.push(prefix);
  // pi can exit 0 on a turn that did not actually settle cleanly, so the answer
  // is still returned but the call is reported as failed.
  if (problem) parts.push(`[warning: ${problem} — the answer below may be incomplete]`);
  if (warnings) parts.push(`[pi stderr: ${warnings}]`);

  if (answer.text) {
    parts.push(clip(answer.text));
  } else {
    // Never fall back to raw stdout: that is the whole NDJSON transcript,
    // including narration, tool arguments and tool results. Returning it as an
    // answer would break the one contract this server makes. Describe the shape
    // of what arrived instead — enough to debug, with no transcript content.
    const seen = acc.messages.length;
    const reasons = [...new Set(acc.messages.map((m) => m.stopReason ?? "none"))].join(", ");
    parts.push(
      "pi returned no usable answer text: its event stream did not match the " +
        "expected `--mode json` contract.\n" +
        `assistant messages seen: ${seen}` +
        (seen ? ` (stopReason: ${reasons})` : "") +
        `, tool calls: ${acc.toolCalls.length}, raw stdout: ${result.stdout.length} chars`,
    );
  }

  parts.push(`---\n${summarize(acc, elapsedMs)}`);
  return toolResult(parts.join("\n\n"), Boolean(problem));
}

async function callPi(input, ctx) {
  const prompt = input?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return toolResult("pi: `prompt` is required and must be a non-empty string.", true);
  }
  if (prompt.length > MAX_PROMPT) {
    return toolResult(
      `pi: prompt is ${prompt.length} chars, over the ${MAX_PROMPT} limit. ` +
        "Write it to a file and point pi at the path instead.",
      true,
    );
  }

  let cwd;
  let extra;
  try {
    cwd = resolveCwd(input.cwd);
    extra = commonArgs(input);
  } catch (err) {
    return toolResult(`pi: ${err.message}`, true);
  }

  const sessionId = randomUUID();
  const { args: tail, cleanup } = promptArgs(prompt);
  const args = ["-p", "--mode", "json", "--session-id", sessionId, ...extra, ...tail];

  let outcome;
  try {
    outcome = await withSlot(() => invokePi({ args, cwd, ...ctx }));
  } finally {
    cleanup();
  }
  const { acc, result, elapsedMs } = outcome;

  if (result.code !== 0) return toolResult(describeFailure(result, acc), true);

  rememberSession(sessionId, cwd, { model: input.model, thinking: input.thinking });
  return renderSuccess(acc, result, elapsedMs, `[session: ${sessionId}]`);
}

async function callPiReply(input, ctx) {
  const session = input?.session;
  const prompt = input?.prompt;
  if (typeof session !== "string" || session.trim() === "") {
    return toolResult("pi_reply: `session` is required.", true);
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return toolResult("pi_reply: `prompt` is required and must be a non-empty string.", true);
  }
  if (prompt.length > MAX_PROMPT) {
    return toolResult(`pi_reply: prompt exceeds the ${MAX_PROMPT} char limit.`, true);
  }

  const known = sessions.get(session);
  let cwd;
  let extra;
  try {
    cwd = resolveCwd(input.cwd ?? known?.cwd);
    extra = commonArgs({
      model: input.model ?? known?.model,
      thinking: input.thinking ?? known?.thinking,
    });
  } catch (err) {
    return toolResult(`pi_reply: ${err.message}`, true);
  }

  const { args: tail, cleanup } = promptArgs(prompt);
  const args = ["-p", "--mode", "json", "--session-id", session, ...extra, ...tail];

  let outcome;
  try {
    outcome = await withSessionLock(session, () =>
      withSlot(() => invokePi({ args, cwd, ...ctx })),
    );
  } finally {
    cleanup();
  }
  const { acc, result, elapsedMs } = outcome;

  if (result.code !== 0) return toolResult(describeFailure(result, acc), true);

  // pi creates a session when the id is unknown, so warn instead of silently
  // starting a fresh conversation the caller thinks is a continuation.
  const isNew = /No project session found with id/i.test(result.stderr ?? "");
  rememberSession(session, cwd, { model: input.model, thinking: input.thinking });
  const prefix = isNew
    ? `[warning: no existing session ${session} in ${cwd} — pi started a new one, so there is no prior context]`
    : null;
  return renderSuccess(acc, result, elapsedMs, prefix);
}

// Utility flag, not an agent run: no session, no json stream, no accumulator.
async function callPiModels(input, ctx) {
  const search = input?.search;
  if (search !== undefined && typeof search !== "string") {
    return toolResult("pi_models: `search` must be a string.", true);
  }
  const args = ["--list-models", ...(search ? [search] : [])];
  const result = await withSlot(() => runPi(args, process.cwd(), { token: ctx?.token }));
  if (result.cancelled) return toolResult("pi_models was cancelled.", true);
  if (result.code !== 0) {
    return toolResult(
      `pi --list-models exited with code ${result.code}.\n\n${tailStderr(result.stderr ?? "")}`,
      true,
    );
  }
  const table = result.stdout.trim();
  if (!table) {
    return toolResult(
      search ? `No pi models match "${search}".` : "pi reported no available models.",
      true,
    );
  }
  return toolResult(table);
}

function callPiSessions() {
  if (sessions.size === 0) {
    return toolResult("No pi sessions recorded yet. Start one with the `pi` tool.");
  }
  const rows = [...sessions.entries()]
    .sort((a, b) => (b[1].lastAccessed || 0) - (a[1].lastAccessed || 0))
    .map(([id, entry]) => {
      const when = entry.lastAccessed ? new Date(entry.lastAccessed).toISOString() : "unknown";
      return `${id}  ${when}  ${entry.cwd}`;
    });
  return toolResult(`${rows.length} session(s), newest first:\n\n${rows.join("\n")}`);
}

// --- JSON-RPC plumbing ---------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// requestId -> cancel token. Registered before the request queues for a slot or
// a session lock, so a cancellation that arrives while waiting is not lost.
const inFlight = new Map();

// JSON-RPC ids 1 and "1" are distinct ids; keying by String(id) alone would let
// them overwrite each other's cancel token.
function requestKey(id) {
  return `${typeof id}:${id}`;
}

function makeCancelToken() {
  const listeners = new Set();
  const token = {
    cancelled: false,
    subscribe(fn) {
      if (token.cancelled) {
        fn();
        return () => {};
      }
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    cancel() {
      if (token.cancelled) return;
      token.cancelled = true;
      for (const fn of listeners) {
        try {
          fn();
        } catch (err) {
          process.stderr.write(`pi-mcp: cancel listener failed: ${err?.message}\n`);
        }
      }
      listeners.clear();
    },
  };
  return token;
}

function makeContext(token, meta) {
  const progressToken = meta?.progressToken;
  let counter = 0;
  return {
    token,
    progress:
      progressToken === undefined || progressToken === null
        ? undefined
        : (message) => {
            counter += 1;
            send({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken, progress: counter, message },
            });
          },
  };
}

async function dispatchTool(name, args, ctx) {
  if (name === "pi") return callPi(args, ctx);
  if (name === "pi_reply") return callPiReply(args, ctx);
  if (name === "pi_models") return callPiModels(args, ctx);
  if (name === "pi_sessions") return callPiSessions();
  return null;
}

async function handle(msg) {
  // A notification is a request without an `id` member. `id: null` is a
  // (discouraged) real id, not the absence of one.
  const hasId = Object.hasOwn(msg, "id");
  const { id, method, params } = msg;

  if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
    if (hasId) replyError(id, -32600, "Invalid Request");
    return;
  }
  if (hasId && id !== null && typeof id !== "string" && typeof id !== "number") {
    replyError(null, -32600, "Invalid Request: id must be a string, number, or null");
    return;
  }

  switch (method) {
    case "initialize": {
      if (!hasId) return;
      const requested = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL;
      reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return;
    case "notifications/cancelled": {
      const token = inFlight.get(requestKey(params?.requestId));
      if (token) token.cancel();
      return;
    }
    case "ping":
      if (hasId) reply(id, {});
      return;
    case "tools/list":
      if (!hasId) return;
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      if (!hasId) return;
      const name = params?.name;
      const args = params?.arguments ?? {};
      const token = makeCancelToken();
      const key = requestKey(id);
      inFlight.set(key, token);
      try {
        const result = await dispatchTool(name, args, makeContext(token, params?._meta));
        if (result === null) replyError(id, -32602, `Unknown tool: ${name}`);
        else reply(id, result);
      } catch (err) {
        reply(id, toolResult(`pi-mcp internal error: ${err?.stack ?? err}`, true));
      } finally {
        inFlight.delete(key);
      }
      return;
    }
    default:
      if (hasId) replyError(id, -32601, `Method not found: ${method}`);
  }
}

loadSessions();

// Shutdown must take the detached process groups with it. They are in their own
// groups precisely so we can kill their whole trees — which also means nothing
// else will ever clean them up if this process just exits.
let shuttingDown = false;

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const trees = liveTrees.size;
  if (trees > 0) {
    process.stderr.write(`pi-mcp: ${reason} — terminating ${trees} running pi process(es)\n`);
    for (const token of inFlight.values()) token.cancel();
    killAllTrees("SIGTERM");
    // Give SIGTERM a moment, then make sure nothing is left behind.
    setTimeout(() => {
      killAllTrees("SIGKILL");
      process.exit(code);
    }, KILL_GRACE_MS).unref();
    return;
  }
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => shutdown(`received ${signal}`, 0));
}
// A dead stdout means the client is gone; keeping pi alive would strand it.
process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") shutdown("stdout closed", 0);
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      // Valid JSON, but not a Request Object. Batches are not supported.
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    handle(msg).catch((err) => {
      if (Object.hasOwn(msg, "id")) {
        replyError(msg.id, -32603, `Internal error: ${err?.message ?? err}`);
      }
    });
  }
  // Refuse an unbounded frame rather than growing until the process dies and
  // every pending response is lost with it.
  if (buffer.length > MAX_FRAME) {
    buffer = "";
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Invalid Request: frame exceeded ${MAX_FRAME} chars` },
    });
  }
});
process.stdin.on("end", () => shutdown("stdin closed", 0));
