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

Requires Node ≥ 20 and a working `pi` on `PATH` (`npm i -g @earendil-works/pi-coding-agent`).

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
| `pi_sessions` | List known sessions, newest first, with their working directory. |

### `pi`

| Argument | Notes |
|---|---|
| `prompt` | Required. Must be self-contained — pi cannot see your conversation. |
| `cwd` | Absolute path. pi reads `AGENTS.md` / `CLAUDE.md` from here. |
| `model` | e.g. `bifrost/minimax/MiniMax-M3`, `sonnet`, `provider/id:thinking`. |
| `thinking` | `off` … `max`. No-op on models without thinking support — check `pi_models`. |
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
| `PI_MCP_TIMEOUT_MS` | `1800000` | Per-call wall clock before pi is killed. |
| `PI_MCP_MAX_CONCURRENT` | `4` | Concurrent pi processes. |
| `PI_MCP_MAX_OUTPUT` | unset | Cap on the answer. Unset means no truncation. |
| `PI_MCP_STDERR_LIMIT` | `1500` | stderr tail included in the response. |
| `PI_MCP_MAX_CAPTURE` | `16000000` | Read-buffer guard against a runaway stream. |
| `PI_MCP_MAX_LINE` | `8000000` | Longest single event line from pi before it is dropped. |
| `PI_MCP_MAX_FRAME` | `8000000` | Longest single JSON-RPC frame from the client. |
| `PI_MCP_MAX_SESSIONS` | `200` | Remembered sessions before the oldest is dropped. |
| `PI_MCP_KILL_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace period. |
| `PI_MCP_STATE` | `~/.local/state/pi-mcp/sessions.json` | Session → cwd map. |
| `PI_MCP_WRAP` | unset | Command prefix, e.g. `sandbox-exec -f profile.sb`. |

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

## Tests

```bash
npm test
```

The suite drives the real server over stdio and uses a fake pi binary for the paths a live model
cannot produce on demand (bad `stopReason`, oversized answers, cancellation), so it needs no API
access and spends no tokens.

## License

MIT
