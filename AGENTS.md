# AGENTS.md

For agents working on this repository. What the server does is in [README.md](README.md); how to
release, validate, test, or touch pi's contract is in
[`.agents/skills/README.md`](.agents/skills/README.md) — read the relevant skill first.

## House rules

**This is an adapter.** It carries pi's capabilities across MCP and adds none of its own. No
automatic messages, no injected instructions, no git or filesystem logic layered on top. If a
behaviour would surprise someone reading pi's own docs, it does not belong here.

**Zero runtime dependencies.** pi's packages are devDependencies reached only through `import type`.
Adding a runtime import is a design change, not a convenience.

**Borrow pi's shapes, never copy them.** Alias its types so a change upstream breaks the build
instead of the answer.

**Fail closed on anything from pi.** An unknown `stopReason`, a missing field, an unparseable
stream — report it. Never normalize the unrecognized into success.

**The answer is the contract.** Return pi's settled answer and aggregate stats. Never the transcript,
tool arguments, or raw stdout: they carry prompts and say nothing a caller can act on.

**Strict in the base, guards on top.** Correctness comes from the protocol, not from pattern
matching. Anything defensive is a separate, switchable layer — and if it parses, it uses the parse
rather than throwing it away for a boolean.

**No process outlives its request.** Every path — timeout, cancellation, shutdown, clean exit —
leaves nothing behind.

**Tests drive the real server.** The fake is pi, never our own code. Wait for conditions; a fixed
sleep before an assertion is a flake with a delay on it.

**Check the artifact, not the number.** A version, a green tick and a tag can all agree while the
published bytes differ. Unpack it, run it.

**Fix it, do not note it.** A violated rule found in passing gets fixed in the same change, whatever
introduced it. And do not commit or push unless asked.
