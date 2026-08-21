---
name: pi-contract
description: How pi-cli-mcp stays honest about pi's wire contract — types borrowed from pi, stop-reason classification, and the type tests that fail when pi changes. Use when touching src/types.ts, src/parse.ts, src/answer.ts, event handling, stopReason logic, or after upgrading the pi packages.
---

# pi's contract

Everything this server reads is pi's data: the `--mode json` event stream and the `stopReason` on
each assistant message. The failure mode is silent drift — pi adds a stop reason or renames an event,
the runtime quietly files it under "unknown", and a delegated answer comes back wrong or a good one
is reported as failed.

## Types are borrowed, not re-described

`src/types.ts` imports pi's own types:

```ts
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
```

`import type` is erased at compile time, so those packages stay devDependencies and the published
package has zero dependencies. `test/packaging.test.ts` enforces both halves: every pi import must be
a type import, and nothing outside `node:` builtins may be imported at runtime.

Do not hand-copy a shape from pi into this repo. Alias it.

## Stop reasons are a partition, checked both ways

pi's vocabulary is `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.
`src/types.ts` splits it into four buckets with `satisfies readonly PiStopReason[]`, which rejects a
reason pi does not have. `test/pi-contract.test-d.ts` checks the other direction — that the buckets
stay exhaustive and disjoint over pi's union — plus that the event names we branch on still exist and
that the `usage` fields we read keep their types.

Run it with `npm test` (typecheck is on) or `npx vitest run --typecheck.only`.

This is not theoretical. Writing that test immediately found:

- **`pending` and `deferred`** were unknown to the classifier, so an ordinary intermediate message
  would have failed the call;
- **`auto_compaction_start`** — a branch on an event pi does not have. The name came from an older
  unrelated fork; pi's is `compaction_start`. Dead code, silently never matching.
- **`tool_execution_start.tool`** — a fallback field pi never sends.

## Untrusted input, even with pi's types

`src/parse.ts` turns `unknown` into those types by checking, never by casting hopefully. Fields can be
missing or retyped: it is another process's JSON. Keep new parsing there rather than inline.

## Fail closed

`src/answer.ts` decides what the answer is and whether the run succeeded:

- the answer is the **last assistant message that settled** — the last whose `stopReason` is not a
  step (`toolUse`, `pending`) — and selection looks at every message, empty ones included;
- the `stopReason` that is validated belongs to **that message**, not to whichever event arrived last;
- a missing or unrecognized `stopReason` is a failure, not a pass;
- raw stdout is **never** returned as an answer. If the stream does not match the contract, report
  the shape of what arrived — message count, stop reasons, tool-call count — never the transcript,
  which carries narration, tool arguments and prompts.

## After upgrading the pi packages

```bash
npm i -D @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest @earendil-works/pi-agent-core@latest
npx vitest run --typecheck.only        # the contract test speaks first
PI_CLI_MCP_LIVE=1 npm test             # then confirm the installed pi behaves that way
```

The type test proves our view matches pi's declared types; the live test proves the installed binary
actually behaves like them. Both, in that order.
