# Changelog

What changed in behaviour, in the order it shipped. Dates are publish dates from the registry.

Only three versions exist on npm — 0.4.0, 0.5.0 and 0.5.1. Anything below 0.4.0 was never
published; the `0.3.0` that lingered in `package-lock.json` was a stale lock, not a release.

## 0.6.0 — 2026-09-02

- **Higher defaults for the two limits that gate how much work one server can hold.** Concurrent pi processes (`PI_MCP_MAX_CONCURRENT`) default to 100 instead of 4, and remembered sessions (`PI_MCP_MAX_SESSIONS`) to 1000 instead of 200. Changed defaults are behaviour changes, so this is a minor rather than a patch.
- An empty completion is attributed to the model instead of the protocol. A turn can settle with
  `stopReason: "stop"` and an entirely empty content array — a well-formed stream where the model
  said nothing. The response used to claim the event stream did not match the expected contract,
  sending the reader after a protocol bug that was not there.

## 0.5.1 — 2026-08-22

- A failed turn reports pi's own reason. pi's error-termination contract puts it in `errorMessage`
  on the failing message; that field was never read, so a session that could not be read after the
  disk filled, or a `400 invalid params` from the provider, both arrived as "no usable answer text".
- README stopped restating what `AGENTS.md` and `.agents/skills/` own.

## 0.5.0 — 2026-08-21

- **`rpc` is the default transport.** It is a superset of `print`: same event stream, same answer,
  plus a running turn stays reachable and an interrupted one is closed in-protocol. `print` remains
  available per call and through `PI_MCP_TRANSPORT`.
- Tool descriptions rewritten around the choices a model gets wrong: new task versus continue versus
  reach-a-running-turn, which lister covers which state, that the prompt is read by an agent which
  cannot see the conversation, and that pi edits files and runs shell commands unless restricted.
- Nothing pi left detached outlives its request. A process group is not empty just because pi
  exited, so the group is now swept on a clean finish too, not only after a kill.
- The handshake version is read from the manifest. It had been hard-coded and was a release behind.

## 0.4.0 — 2026-08-21

- **A killed run is resumable instead of lost.** Timeout, cancellation and non-zero exit return the
  session id, the last thing pi said, what it did, and the `pi_reply` call to continue with. The
  session is recorded before the run rather than after it succeeds.
- **`timeout_ms` per call.** A single global deadline ended long work at a point unrelated to the
  task.
- **A running turn can be sent a message.** `pi_send` passes pi's own `steer` / `follow_up` /
  `abort` into a live rpc turn; `pi_running` lists what is reachable. Nothing is ever sent on the
  server's initiative.
- An interrupted rpc turn is closed with pi's `abort` before any signal, because pi skips its stdout
  flush on `SIGTERM` and signalling first can cost the tail of the stream.
- stderr lines that parse as protocol events are tallied by type instead of pasted in with their
  payloads and prompts.
- Rewritten in TypeScript, with pi's wire types borrowed rather than re-described, and type tests
  that fail when pi's own types move. Runtime dependencies: none.
