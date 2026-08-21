# pi-cli-mcp

MCP server that delegates coding tasks to your **locally installed** [pi](https://pi.dev) CLI.

It wraps the real `pi` binary instead of bundling its own copy of the agent, so every call inherits
your `~/.pi/agent/settings.json` — provider, models, thinking level, extensions, `AGENTS.md` /
`CLAUDE.md` discovery. Nothing about your model stack is duplicated here, and the server does not
drift when you upgrade pi.

Use it when your primary agent (Claude Code, Cursor, any MCP client) should hand work to pi: a
second opinion from a different model, an investigation you want kept out of the main context
window, or parallel work.

## Install

```bash
npx -y pi-cli-mcp            # no install
npm install -g pi-cli-mcp    # or global
```

Requires Node ≥ 22 and a working `pi` on `PATH` (`npm i -g @earendil-works/pi-coding-agent`).

### Claude Code

```bash
claude mcp add-json pi -s user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "pi-cli-mcp"],
  "timeout": 3600000
}'
claude mcp list | grep '^pi:'      # expect: ✔ Connected
```

The generous `timeout` matters: a real delegated task can run for minutes.

### Any other MCP client

```json
{
  "mcpServers": {
    "pi": { "command": "npx", "args": ["-y", "pi-cli-mcp"] }
  }
}
```

Keep the server name short (`pi`): it becomes part of the tool names your model sees.

## Tools

| Tool | Purpose |
|---|---|
| `pi` | Start a pi session. Returns `[session: <uuid>]`, the answer, and stats. |
| `pi_reply` | Continue a session by id. pi still holds the prior turns. |
| `pi_models` | List reachable models (provider, id, context, max output, thinking, images). |
| `pi_send` | Send a message into a turn that is running right now (`rpc` transport only). |
| `pi_running` | List turns executing right now and reachable by `pi_send`. |
| `pi_sessions` | List known sessions, newest first, with their working directory. |

### `pi`

| Argument | Notes |
|---|---|
| `prompt` | Required. Must be self-contained — pi cannot see your conversation. |
| `cwd` | Absolute path. pi reads `AGENTS.md` / `CLAUDE.md` from here. |
| `model` | e.g. `bifrost/minimax/MiniMax-M3`, `sonnet`, `provider/id:thinking`. |
| `thinking` | `off` … `max`. No-op on models without thinking support — check `pi_models`. |
| `timeout_ms` | Wall clock for this run. Set it from the task; the server default is only a default. |
| `tools` | Allowlist, e.g. `read,grep,find,ls` for a read-only run. |
| `no_tools` | Pure reasoning over the prompt text. |
| `system_prompt_append` | Extra text appended to pi's system prompt. |

```js
pi({
  prompt: "Map how retries are wired in src/http.rs. Report call sites only.",
  cwd: "/abs/path/to/repo",
  tools: "read,grep,find,ls"
})
```

> **pi has no permission system.** With its default tools it edits files and runs shell commands as
> your user inside `cwd`. Pass `tools` or `no_tools` whenever the task is analysis. Use
> `PI_MCP_WRAP` if you want a sandbox.

## What comes back

Only pi's final answer plus aggregate stats — never the transcript, tool arguments or tool output:

```
[session: 0927adc5-a840-4b68-93ca-5ca344c9fafb]

Created note.md containing "hello" and updated target.txt to read "new content".

---
pi: bifrost/minimax/MiniMax-M3 · 5 turns · 4 tool calls: bash, read, write, edit · 11k in / 276 out · 9.8s
pi wrote: note.md, target.txt
```

- **"Final answer" is defined by `stopReason`**, not by position: the last assistant message that
  settled — the last one whose `stopReason` is not `toolUse`, which is how pi marks tool-call steps.
  Mid-run narration is dropped even when a preamble shares a message with a tool call. If the
  settled message has no text, that is reported as a broken run rather than silently reaching back
  for an earlier preamble. If nothing settled at all, the last text produced is returned, labelled
  as such.
- **The answer is never truncated.** Set `PI_MCP_MAX_OUTPUT` if you want a cap. Only diagnostics
  are bounded.
- **`pi wrote:` appears only when pi actually wrote files**, so it doubles as a side-effect check.
- **Bad `stopReason` fails the call, fail-closed.** `stop` / `length` are success; `error`,
  `aborted`, a missing `stopReason`, and anything outside the known vocabulary are reported as
  errors with the answer still attached. The `stopReason` that is validated belongs to the message
  being returned, not to whichever event arrived last. pi can exit 0 on a turn that did not settle
  cleanly, so the exit code alone is not trusted.
- **Raw stdout is never returned as an answer.** If the event stream does not match the expected
  contract, the response says so and describes the shape of what arrived (message count,
  `stopReason` values, tool-call count, byte count) — never the transcript itself, which would leak
  narration, tool arguments and tool results.

## Sessions

`pi` returns a session id; `pi_reply` continues it. The conversation lives in pi's own session
files, so follow-ups keep working across restarts of this server — the session → directory map is
persisted in `~/.local/state/pi-mcp/sessions.json`.

Concurrent replies to one session are serialized: two pi processes writing one session file would
corrupt it. If an id is unknown, pi starts a fresh conversation and the answer carries an explicit
`[warning: no existing session …]` rather than pretending to continue.

**Cross-process caveat.** The session mutex is process-local. If you run two MCP clients against
two server processes and both reply to the *same* session id at the same time, nothing serializes
them. The state file is written with re-read-then-merge, so sessions learned by one process are not
erased by the other, but the underlying pi session file has no such protection. In practice one
client owns a session; if you need a hard guarantee, keep one server process.

## Transports

Two ways to drive pi, behind one interface. Everything downstream — the event
accumulator, answer selection, the stats line, failure reporting — is shared, so
the choice changes only how pi is launched and what is possible during a run.

| | `print` (default) | `rpc` |
|---|---|---|
| command | `pi -p --mode json` | `pi --mode rpc` |
| process | one per turn, exits when done | stays up, reads JSONL commands on stdin |
| mid-run message | impossible: pi reads nothing while working | `pi_send` |
| prompt delivery | argv, with a temp file for long or dash-leading prompts | inside the command, no argv limit |

Pick per call with `transport`, or set the default with `PI_MCP_TRANSPORT=rpc`.

### Reaching a running turn

`pi --mode rpc` accepts commands while it works. That is the whole reason the
transport exists, and it is exposed as pi's commands, unchanged:

```js
pi({ prompt: "long task…", cwd: "/repo", transport: "rpc" })   // still running

pi_running()
// 1 running:
// 5aef3387-…  8.0s  /repo

pi_send({ session: "5aef3387-…", message: "stop and report what you have" })
// Sent steer to session 5aef3387-… (running for 8.1s).
```

The answer appears in the call that is still waiting on that turn:

```
[session: 5aef3387-…]

STEERED_LIVE

---
pi: bifrost/agnes/agnes-2.5-flash · 3 turns · 3 tool calls: bash×3 · 23k in / 207 out · 46.6s
```

`command` selects which pi command to pass: `steer` (default, interrupts the
current turn), `follow_up` (queues for after it), `abort` (stops it).

### Ending a turn early

A deadline or a cancellation ends an rpc turn with pi's own `abort` first, and
only signals if that does not take within `PI_MCP_ABORT_GRACE_MS`. The reason is
in pi's own shutdown path: on SIGTERM it deliberately skips `flushRawStdout()`,
so signalling straight away can cost the tail of the event stream — including the
answer pi was in the middle of writing. After `abort` the turn closes through the
normal path and its report arrives. Print mode has no stdin to talk to, so there
it is SIGTERM then SIGKILL as before.

The report says which happened: `the turn was aborted` means it closed itself and
the events are complete, `the process was killed` means it was cut off.

**This server never sends anything on its own.** There is no automatic "please
wrap up" before a deadline, no injected instructions: `pi_send` fires only when
the caller calls it. What to send, and whether to send at all, is a decision the
adapter has no business making.

## When a run dies

A run killed by its deadline, by cancellation, or by a non-zero exit is not a
dead end — pi keeps the conversation in its own session file, so the work is
parked rather than lost. The failure carries what is needed to pick it back up:

```
[session: 0927adc5-…]

[error: pi timed out after 1800000 ms and was killed]

last thing pi said:
43 tests pass, now showing the failure

progress before it died:
pi: bifrost/zai/glm-5.3 · 9 turns · 14 tool calls: bash×6, read×5, edit×3 · 61k in / 4.2k out · 1800.0s
pi wrote: tests/test_upstream.py, conftest.py

The session is intact and resumable — pi still has every turn above.
To continue where it stopped:
  pi_reply({ session: "0927adc5-…", prompt: "..." })
Raise the limit for the next leg with timeout_ms if the task needs longer.
```

The session is recorded **before** the run starts, not after it succeeds, so a
killed run is still listed by `pi_sessions` and still resumable. The files line
comes from pi's own tool calls — this server does not inspect the filesystem.

`timeout_ms` exists because the right deadline belongs to the task. A global
limit kills long work at an arbitrary point; per-call it is a decision, and the
report above makes the decision recoverable either way.

### stderr

stderr is diagnostics, and only the tail is forwarded (`PI_MCP_STDERR_LIMIT`).
By the protocol, events belong on stdout, so a stderr line that *parses* as an
event is a channel violation: those lines are counted by type and reported as
`[6 protocol event line(s) on stderr, suppressed: message_start×3, message_end×3]`
rather than pasted in. The classification comes from parsing the line once and
reusing that parse for the tally — the payloads, prompts included, are never
forwarded. `PI_MCP_STDERR_KEEP_EVENTS=1` turns the guard off and forwards stderr
verbatim.

## Cancellation

MCP `notifications/cancelled` kills pi with `SIGTERM`, escalating to `SIGKILL` after a grace period.
Children go with it: pi runs in its own process group and the whole tree is signalled, so an
interrupted `sleep 120` does not survive even if pi fails to forward the signal.

Cancellation registers before the call queues for a concurrency slot or a session lock, so a call
that is cancelled while still waiting never starts pi at all.

Shutdown — stdin EOF, `SIGTERM`, `SIGINT`, `SIGHUP`, or a closed stdout — reaps every running pi
tree before exiting. Detached children have no other parent to clean them up.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PI_MCP_BIN` | `pi` | Path to the pi binary. |
| `PI_MCP_MODEL` | pi's setting | Default model for every call. |
| `PI_MCP_THINKING` | pi's setting | Default thinking level. |
| `PI_MCP_TIMEOUT_MS` | `1800000` | Default wall clock; `timeout_ms` overrides it per call. |
| `PI_MCP_MAX_TIMEOUT_MS` | `86400000` | Ceiling on what `timeout_ms` may ask for. |
| `PI_MCP_MAX_CONCURRENT` | `4` | Concurrent pi processes. |
| `PI_MCP_MAX_OUTPUT` | unset | Cap on the answer. Unset means no truncation. |
| `PI_MCP_STDERR_LIMIT` | `1500` | stderr tail included in the response. |
| `PI_MCP_STDERR_KEEP_EVENTS` | unset | `1` forwards stderr verbatim, event lines included. |
| `PI_MCP_MAX_CAPTURE` | `16000000` | Read-buffer guard against a runaway stream. |
| `PI_MCP_MAX_LINE` | `8000000` | Longest single event line from pi before it is dropped. |
| `PI_MCP_MAX_FRAME` | `8000000` | Longest single JSON-RPC frame from the client. |
| `PI_MCP_MAX_SESSIONS` | `200` | Remembered sessions before the oldest is dropped. |
| `PI_MCP_KILL_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace period. |
| `PI_MCP_ABORT_GRACE_MS` | `5000` | How long `abort` gets before signals (rpc only). |
| `PI_MCP_STATE` | `~/.local/state/pi-mcp/sessions.json` | Session → cwd map. |
| `PI_MCP_WRAP` | unset | Command prefix, e.g. `sandbox-exec -f profile.sb`. |
| `PI_MCP_TRANSPORT` | `print` | Default transport: `print` or `rpc`. |

## Design

- **Process per call.** pi's own session files are the source of truth, which is what makes
  follow-ups survive a restart of this server.
- **`pi -p --mode json`.** The json event stream is what yields turns, tool calls, token usage and
  cost — no scraping of human-readable output.
- **No dependencies.** Newline-delimited JSON-RPC 2.0 is spoken directly, so there is no SDK to
  keep in sync and nothing to audit but one file.
- **Long or dash-leading prompts** are passed as an `@file` attachment, since pi has no `--`
  separator and argv has an OS size limit.

### Why not the alternatives

`pandysp/pi-mcp-server` depends on `@mariozechner/pi-coding-agent@^0.52.9` — the old fork under
pi's previous package name — so it runs a bundled copy of a much older agent instead of your CLI,
and knows only a fixed provider list. Everything else in the ecosystem (`pi-mcp-adapter`,
`pi-mcp-extension` and forks) runs the opposite direction: MCP servers *into* pi. `pi` itself has
no native `mcp-server` subcommand.

## Development

TypeScript, mirroring pi's own toolchain — one version newer where there is a newer one.

| | pi 0.84 | here |
|---|---|---|
| compiler | `tsgo` dev-preview + typescript 5.9 | **typescript 7** (`tsc`, the native compiler, stable) |
| lint / format | Biome 2.3.5, `recommended: true` | **Biome 2.5.9**, `preset` (the field that replaced it) |
| tests | Vitest 4.1.9 | **Vitest 4.1.11**, with `--typecheck` on |
| module | `Node16` | **`nodenext`** |
| strictness | `strict`, `erasableSyntaxOnly` | plus `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters` |

```bash
npm run build          # tsc -> dist/
npm test               # unit + type tests, no API access, no tokens
npm run check          # format + types + tests
npm run fix            # biome --write
PI_CLI_MCP_LIVE=1 npm test   # also exercise the real pi binary
```

### Types come from pi

`src/types.ts` does not re-describe pi's wire shapes — it imports them:

```ts
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
```

`import type` is erased at compile time, so those packages stay devDependencies and the published
output has **zero** dependencies (`test/packaging.test.ts` enforces both: every pi import is a type
import, and nothing outside `node:` builtins is imported at runtime).

The stop-reason classification is checked against pi in two directions:

- `satisfies readonly PiStopReason[]` in `src/types.ts` rejects a reason pi does not have;
- `test/pi-contract.test-d.ts` fails the typecheck if pi adds one we do not classify, if the four
  buckets overlap, if an event we branch on is renamed, or if a `usage` field we read changes type.

That test earned its keep immediately: it caught a branch on `auto_compaction_start`, an event name
that does not exist in pi (it came from an unrelated older fork — the real one is `compaction_start`),
and a `tool_execution_start.tool` fallback that pi never sends. Both were dead code silently doing
nothing.

`test/live.test.ts` is the runtime counterpart: the type test proves our view matches pi's declared
types, the live test proves the installed pi actually behaves that way.

### Fixture, not mocks

`test/fixtures/fake-pi.mjs` is a stand-in pi binary that emits a real `--mode json` event stream. It
covers what a live model cannot produce on demand: a bad or unknown `stopReason`, a settled-but-empty
message, a 200k-char answer, a stream that is not JSON, a final event without a trailing newline, a
hung process, and a lockfile-based overlap detector that fails if the session mutex is removed.

## License

MIT
