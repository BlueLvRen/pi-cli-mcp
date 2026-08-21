---
name: testing
description: How the pi-cli-mcp suite is built — the fake pi binary, its scenarios, the live opt-in, and the traps that make these tests flaky if ignored. Use when adding or debugging a test, adding a fixture scenario, or when the suite passes alone but fails in a full run.
---

# Testing

The suite drives the **real server over stdio** and points it at a fake pi binary. No mocks of our
own code: a test that passes against a stub of `runPi` would prove nothing about the protocol.

```bash
npm test                      # suite + type tests, no API access, no tokens
PI_CLI_MCP_LIVE=1 npm test    # also runs the real pi binary
npx vitest run test/x.test.ts # one file
```

Tests run the server from `src/` through Node's TypeScript support, so they exercise the source, not
a stale `dist/`.

## Layout

| file | covers |
|---|---|
| `protocol.test.ts` | handshake, JSON-RPC conformance, notifications, frame limits |
| `answer.test.ts` | answer selection, stop-reason handling, stats line, input validation |
| `failure.test.ts` | what a killed run reports: session id, progress, resumability, stderr scrubbing |
| `lifecycle.test.ts` | timeout, cancellation, shutdown, concurrency, leftover-process cleanup |
| `sessions.test.ts` | continuity across restarts, remembered options, the session mutex |
| `transport.test.ts` | print vs rpc, and reaching a running turn |
| `packaging.test.ts` | zero runtime dependencies, publishable file list |
| `pi-contract.test-d.ts` | types against the installed pi — see the `pi-contract` skill |
| `live.test.ts` | the real pi, opt-in |

## The fake pi

`test/fixtures/fake-pi.mjs` emits a pi-shaped `--mode json` stream and speaks the rpc command
protocol. It exists for the paths a live model will not produce on demand: a bad or unknown
`stopReason`, a settled-but-empty message, a 200k answer, a stream that is not JSON, a final event
without a trailing newline, a hung process, transcript data leaking onto stderr, and a lockfile-based
overlap detector that fails if the session mutex is removed.

Scenarios are chosen with `FAKE_MODE`; see the header comment for the list and the env switches.

Rules learned the hard way when editing it:

- **Never `process.exit()` after writing.** stdout to a pipe is async and exiting truncates it. Set
  `process.exitCode`. This bug once cut a 200k answer short and made a real test lie.
- **`process.exitCode` does not stop execution.** A branch that sets it must also `return`, or it
  falls through into the event stream — that is how the `--list-models` table once got polluted with
  agent events while substring assertions hid it.
- **Scenarios that must hang set `holding = true`.** They return as soon as their timers are armed,
  and the rpc path would otherwise read "the function returned" as "the turn is over" and exit —
  turning a timeout test into an instant clean exit.
- **`sh -c` execs a single command**, replacing its own image and dropping the tag from the command
  line that `pgrep -f` matches. Hence `sleep 120; true # tag`.

## Two traps that cause phantom failures

**Fixed sleeps.** Test files run in parallel. A test that sleeps 700 ms waiting for a child process
passes alone and fails under load — three lifecycle tests did exactly that. Use `waitFor` from
`test/helpers/client.ts`, which waits for the condition with a deadline.

**Shared process names.** `pgrep -f "sleep 120"` sees other files' children. Each file that inspects
processes defines its own `CHILD_TAG` and passes it as `FAKE_CHILD_TAG`; the fixture puts it in the
child's command line. Without this, files reap each other's processes and blame the wrong code.

## When a test needs a real pi

Put it in `live.test.ts` behind `describe.runIf(live)`. Keep it cheap — `no_tools` and a one-word
answer where possible — and assert something the fake cannot prove: that the installed pi really
behaves the way its types claim.
