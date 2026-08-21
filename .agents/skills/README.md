# Skills

Procedures for working on this repository, kept next to the code they describe. Each is a
`SKILL.md` with a `description` that says when to reach for it.

| skill | when |
|---|---|
| [`release`](release/SKILL.md) | cutting a version, tagging, publishing, verifying what landed on npm |
| [`validation`](validation/SKILL.md) | the git hooks, what each guards, what to do when one refuses |
| [`pi-contract`](pi-contract/SKILL.md) | touching event handling, `stopReason` logic, or upgrading the pi packages |
| [`testing`](testing/SKILL.md) | adding or debugging tests, editing the fake pi, chasing a flake |

Two rules run through all four, because both were learned by getting them wrong here:

**Check the artifact, not the number.** A version in `package.json`, a green CI badge and a tag all
agreeing still said nothing about what was inside the published tarball — that had to be unpacked and
run.

**A guard that cannot fail is not a guard.** The suite passed while branching on an event pi does not
emit; a test asserted both the presence and absence of the same string; a lockfile rotted through
several releases because `npm ci` accepts a stale one. Prefer a check that has demonstrably caught
something over one that merely sounds prudent.
