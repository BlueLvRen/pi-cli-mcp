# pi-cli-mcp

MCP server that delegates coding tasks to your **locally installed** [pi](https://pi.dev) CLI.

It wraps the real `pi` binary instead of bundling its own copy of the agent, so every call inherits
your `~/.pi/agent/settings.json` — provider, models, thinking level, extensions, `AGENTS.md` /
`CLAUDE.md` discovery. Nothing about your model stack is duplicated here, and the server does not
drift when you upgrade pi.

Use it when your primary agent (Claude Code, Cursor, any MCP client) should hand work to pi: a
second opinion from a different model, an investigation you want kept out of the main context
window, or parallel work.

## Fork 说明

本项目是基于 [minmax/pi-cli-mcp](https://github.com/minmax/pi-cli-mcp) 的 fork，当前维护仓库为
[BlueLvRen/pi-cli-mcp](https://github.com/BlueLvRen/pi-cli-mcp)。上游项目采用 MIT License；本 fork
保留原版权和许可证，并在此基础上持续维护增强功能。

当前 fork 的主要改动：

- 增加 MCP 标准 `notifications/progress` 进度通知，报告排队、运行、工具调用、收尾、完成和失败等阶段。
- 增加 `pi_start` 非阻塞启动入口，支持“启动 → 查询 → 干预 → 取回结果”的调用流程。
- 支持通过 `stream: true` 选择性接收模型文本增量；默认仍保持原有阻塞式最终结果兼容性。
- `pi`、`pi_start` 和带 prompt 的 `pi_reply` 支持通过 `images` 传入内联图片，并在图片输入失败时返回稳定的结构化错误。
- 丰富 `pi_running` 输出，提供运行状态、已耗时、最后进度事件以及 `pi_send`/终止能力信息。
- 增强 Windows 支持，包括 `.cmd`/`.bat` 形式的 pi 命令、进程树清理和跨平台构建脚本。

除上述增强外，项目仍遵循上游的 MCP 工具接口、会话机制和传输模式设计。提交问题或贡献代码时，
请优先说明使用的是本 fork 还是上游版本。

## Install

```bash
npx -y pi-cli-mcp     # no install
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

The generous `timeout` matters: the server applies no run deadline by default, and a real
delegated task can run for minutes.

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
| `pi_start` | Start a pi session in the background and return its session id immediately. |
| `pi_reply` | Continue a session that is not executing — including one killed by a timeout. |
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
| `timeout_ms` | Wall clock for this run. Off unless you set it — the task decides whether it needs a deadline. |
| `tools` | Allowlist, e.g. `read,grep,find,ls` for a read-only run. |
| `no_tools` | Pure reasoning over the prompt text. |
| `system_prompt_append` | Extra text appended to pi's system prompt. |
| `stream` | Opt in to model text deltas in MCP progress notifications. Requires a progress token. |
| `images` | Optional inline images: `{ data, mimeType }`. `data` accepts raw base64 or a `data:image/...;base64,...` URI. |

```js
pi({
  prompt: "Map how retries are wired in src/http.rs. Report call sites only.",
  cwd: "/abs/path/to/repo",
  tools: "read,grep,find,ls",
  stream: true
})
```

图片示例（图片不会被拼进 prompt，而是按 Pi 的 `ImageContent` 传输）：

```js
pi({
  prompt: "请描述这张图片，并指出其中的文字。",
  model: "provider/vision-model",
  images: [{ data: "iVBORw0KGgo...", mimeType: "image/png" }]
})
```

`images` 的约束：支持 JPEG、PNG、GIF、WebP；每张图片最多 32 MiB，单次最多 600 张，解码后图片总量最多 64 MiB。服务端会校验 Base64、Data URI 的 MIME 类型和实际文件头。当前只接受内联 Base64，不接受本地路径、远程 URL 或 provider-specific `file_id`。默认 MCP JSON-RPC frame 上限为 48,000,000 字符，可用 `PI_MCP_MAX_FRAME` 调整。

图片输入使用 `rpc` transport。`print` transport 没有 Pi 的图片 prompt 通道，会在启动前返回 `image_transport_error`。模型是否支持图片以 `pi_models` 的 `images` 列为参考；provider 仍可能拒绝请求，服务端不会静默丢弃图片。

图片相关失败同时返回人类可读文本和 `structuredContent.error`：

```json
{
  "code": "unsupported_model",
  "message": "The selected pi model/provider rejected image input...",
  "retryable": false
}
```

稳定错误码包括 `invalid_image_data`、`unsupported_mime_type`、`image_too_large`、`image_request_too_large`、`image_transport_error`、`image_input_not_allowed`、`unsupported_model` 和 `image_provider_error`。`pi_reply({ session })` 不带 prompt 时只是取回 `pi_start` 的结果，因此不能同时传 `images`；需要新图片轮次时请提供 prompt。

When the caller supplies an MCP progress token, `pi` and `pi_reply` emit standard
`notifications/progress` messages while the blocking call is running. They include a stable
`status` (`queued`, `running`, `tool`, `settling`, `finished`, or `failed`), the session id,
elapsed milliseconds, and a safe progress message. With `stream: true`, model text deltas are
also included in the extension field `text`; raw stdout, prompts, tool arguments, and tool output
are never forwarded.

> **pi has no permission system.** With its default tools it edits files and runs shell commands as
> your user inside `cwd`. Pass `tools` or `no_tools` whenever the task is analysis. Use
> `PI_MCP_WRAP` if you want a sandbox.

### `pi_start`

`pi_start` is the non-blocking counterpart to `pi`. It always uses the `rpc` transport and returns
the session id immediately:

```js
pi_start({ prompt: "Run the test suite and fix failures.", cwd: "/repo" })
// [session: 5aef3387-…]
// [run: 5aef3387-…]
// Started in the background. Use pi_running to query progress, pi_send to intervene,
// and pi_reply({ session }) to retrieve the final result.
```

The caller controls the lifecycle. `pi_running` reports status, elapsed time, the latest safe
progress message, and whether `pi_send` is currently available. `pi_send` can steer, queue a
follow-up, or abort; no message is sent automatically. After the run settles, call
`pi_reply({ session })` without a prompt to wait for or retrieve its final result. To continue or
recover the session with a new turn, provide a prompt as usual:

```js
pi_reply({ session: "5aef3387-…" })
pi_reply({ session: "5aef3387-…", prompt: "Continue from the last checkpoint." })
```

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

| | `rpc` (default) | `print` |
|---|---|---|
| command | `pi --mode rpc` | `pi -p --mode json` |
| process | stays up, reads JSONL commands on stdin | one per turn, exits when done |
| mid-run message | `pi_send` | impossible: pi reads nothing while working |
| interrupted by deadline or cancel | pi's own `abort` first, signals only as fallback | SIGTERM, then SIGKILL |
| prompt delivery | inside the command, no argv limit | argv, with a temp file for long or dash-leading prompts |

`rpc` is the default because it is a superset: the same event stream and the same answer, plus a
running turn stays reachable and an interrupted one is ended in-protocol. Pick per call with
`transport`, or set the default with `PI_MCP_TRANSPORT=print`.

### Reaching a running turn

`pi --mode rpc` accepts commands while it works. That is the whole reason the
transport exists, and it is exposed as pi's commands, unchanged:

A call blocks until the turn settles, so reaching it needs a second caller — or a client that stops
waiting. Claude Code, for one, moves a tool call to the background after about two minutes, and from
that point the turn is reachable from the same conversation:

```js
pi({ prompt: "long task…", cwd: "/repo" })   // moved to the background by the client

pi_running()
// 1 running:
// 5aef3387-…  status=running  elapsed=8.0s  cwd=/repo  can_send=true can_abort=true  last_event_at=…  last: running bash

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

Nothing is ever sent on this server's initiative: `pi_send` fires only when you call it.

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

`timeout_ms` exists because the right deadline belongs to the task. By default
the server sets no deadline at all — pi runs until it finishes. Give the task a
wall clock when it needs one, or install a server-wide default with
`PI_MCP_TIMEOUT_MS`; a global limit would otherwise kill long work at an
arbitrary point, while per-call it is a decision, and the report above makes
the decision recoverable either way.

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
| `PI_MCP_TIMEOUT_MS` | unset | Server-wide default wall clock; unset means no deadline. `timeout_ms` overrides it per call. |
| `PI_MCP_MAX_TIMEOUT_MS` | `86400000` | Ceiling on what `timeout_ms` may ask for. |
| `PI_MCP_MAX_CONCURRENT` | `100` | Concurrent pi processes. |
| `PI_MCP_MAX_OUTPUT` | unset | Cap on the answer. Unset means no truncation. |
| `PI_MCP_STDERR_LIMIT` | `1500` | stderr tail included in the response. |
| `PI_MCP_STDERR_KEEP_EVENTS` | unset | `1` forwards stderr verbatim, event lines included. |
| `PI_MCP_MAX_CAPTURE` | `16000000` | Read-buffer guard against a runaway stream. |
| `PI_MCP_MAX_LINE` | `8000000` | Longest single event line from pi before it is dropped. |
| `PI_MCP_MAX_FRAME` | `48000000` | Longest single JSON-RPC frame from the client; relevant to inline image payloads. |
| `PI_MCP_MAX_SESSIONS` | `1000` | Remembered sessions before the oldest is dropped. |
| `PI_MCP_KILL_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace period. |
| `PI_MCP_ABORT_GRACE_MS` | `5000` | How long `abort` gets before signals (rpc only). |
| `PI_MCP_STATE` | `~/.local/state/pi-mcp/sessions.json` | Session → cwd map. |
| `PI_MCP_WRAP` | unset | Command prefix, e.g. `sandbox-exec -f profile.sb`. |
| `PI_MCP_TRANSPORT` | `rpc` | Default transport: `rpc` or `print`. |

## Design

- **Process per call.** pi's own session files are the source of truth, which is what makes
  follow-ups survive a restart of this server.
- **`pi -p --mode json`.** The json event stream is what yields turns, tool calls, token usage and
  cost — no scraping of human-readable output.
- **No dependencies.** Newline-delimited JSON-RPC 2.0 is spoken directly; installing this package
  pulls nothing else in.
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
npm run hooks          # once per clone: git hooks from .githooks/
npm run build          # tsc -> dist/
npm test               # unit + type tests, no API access, no tokens
npm run check          # format + types + tests
npm run fix            # biome --write
PI_CLI_MCP_LIVE=1 npm test   # also exercise the real pi binary
```

What changed between versions is in [CHANGELOG.md](CHANGELOG.md). House rules are in
[AGENTS.md](AGENTS.md); procedures — releasing, validation, pi's contract, testing — in
[`.agents/skills/`](.agents/skills/).

## License

MIT
