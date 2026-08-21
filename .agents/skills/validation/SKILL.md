---
name: validation
description: Local checks for pi-cli-mcp — the git hooks, what each one guards, and what to do when one refuses a commit or a push. Use when setting up a clone, when a hook blocks you, or when deciding whether a new check is worth adding.
---

# Validation

Two hooks, three checks. The set is deliberately small: a hook that takes real time gets bypassed
with `--no-verify`, and then it does not exist.

```bash
npm run hooks    # once per clone — points core.hooksPath at .githooks/
```

Not wired into `prepare`: that also runs for anyone installing this package from git, and their
hooks are not ours to configure.

## pre-commit — seconds

| check | why it exists |
|---|---|
| `biome check .` | formatting and lint. A `package.json` written with spaces instead of tabs broke `npm run check` once. |
| lock regeneration | `npm install --package-lock-only` and refuse if `package-lock.json` moved. |

The lock check earns its place because nothing else catches it: **`npm ci` accepts a lock that has
drifted from `package.json`** — verified on a clean clone of a tag whose lock was two minor versions
behind. It rotted from `0.3.0` onward, `bin` still pointing at `index.mjs` long after the file was
gone, and went out inside a release tag.

When it fires, the lock has already been regenerated for you. Review it, stage it, commit again.

## pre-push — the whole suite

`npm test` — Vitest plus the type tests. This is the run that compares our view of pi's wire
contract against the installed `@earendil-works/pi-*` types; see the `pi-contract` skill. It is the
last gate before anything leaves the machine.

## Checks that were considered and dropped

Kept out on purpose, so the list stays worth reading:

| rejected | reason |
|---|---|
| "no version literal in `src/`" | the handshake version is read from `package.json` now — the duplicate cannot come back by accident |
| `*.tgz` / stray-file guard | one line in `.gitignore` does it; a hook adds nothing |
| "no orphaned processes after tests" | already asserted by `child_then_answer` in `test/lifecycle.test.ts` |
| `npm run build` in pre-push | compilation is covered by the type check; `prepare` and CI build anyway |
| a separate `tsc --noEmit` in pre-commit | duplicates the typecheck inside `npm test` |

## What hooks cannot catch

Do not expect these to be caught by tooling — they need reading:

- **A test that contradicts itself.** One assertion here demanded both the presence and the absence
  of `message_start` in the same response.
- **Timing-dependent tests.** Three lifecycle tests slept a fixed 700 ms waiting for a child process
  and passed alone, failing only under the load of the full suite. Use `waitFor` from
  `test/helpers/client.ts` instead of a sleep before an assertion.
- **A Node version difference against CI.** `--experimental-strip-types` is required on Node 22 and
  deprecated from 23; CI installs 24. A local hook knows nothing about that. `test/helpers/client.ts`
  now picks the flag by version, but the general answer is a CI matrix, not a hook.
