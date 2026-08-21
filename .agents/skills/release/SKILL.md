---
name: release
description: Cut and publish a pi-cli-mcp release — version bump, lockfile, tag, and the CI publish that carries provenance. Use when asked to release, publish, bump the version, or ship a new npm version of pi-cli-mcp.
---

# Releasing pi-cli-mcp

Publishing happens in CI, triggered by a tag. `npm publish` from a workstation works but produces a
package **without provenance** — 0.4.0 went out that way and has `dist.attestations: null`, while
0.5.0 went through the tag and carries a SLSA attestation. Use the tag.

## The sequence

```bash
npm version <new-version> --no-git-tag-version   # updates package.json AND package-lock.json
npm run check                                    # format, types, full suite
git add package.json package-lock.json
git commit
git tag -a vX.Y.Z -m "<what changed in behaviour>"
git push origin main
git push origin vX.Y.Z                           # this is what publishes
```

Then confirm, on the registry rather than on trust:

```bash
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
npm view pi-cli-mcp version
npm view pi-cli-mcp --json | python3 -c "import json,sys; print(json.load(sys.stdin)['dist'].get('attestations'))"
```

`attestations: null` means the tag path was bypassed.

## Choosing the number

Pre-1.0, so nothing is strictly forced, but keep the signal honest: a changed **default** is a
behaviour change even when the API is identical. Making `rpc` the default transport went out as
0.5.0, not 0.4.1, so that anyone reading the number sees it.

## What has actually gone wrong here

- **`npm version` vs hand-editing.** Bumping the version by editing `package.json` directly leaves
  `package-lock.json` behind. That lock sat on `0.3.0` — with a `bin` path that stopped existing at
  the TypeScript migration — and shipped inside tag `v0.5.0` that way. `npm ci` accepts such a lock
  without complaint, so CI will not tell you. The pre-commit hook now will; see the `validation`
  skill.
- **A second copy of the version.** `SERVER_INFO` used to hard-code it, and the copy clients see in
  the MCP handshake was a release behind. It is read from `package.json` now — do not reintroduce a
  literal.
- **Push `main` too.** Only the tag is needed to publish, but if `main` lags, the README people read
  describes different behaviour from the package they installed.

## Verifying the published artifact

Version numbers are not evidence. Check the tarball's contents, then run it:

```bash
npm pack pi-cli-mcp@X.Y.Z && tar xzf pi-cli-mcp-X.Y.Z.tgz
ls package/dist package/dist/transport
python3 -c "import json;print(json.load(open('package/package.json'))['dependencies'])"   # must be {}
```

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | npx -y pi-cli-mcp@X.Y.Z
```

The handshake must report the version you just published, and the package must install with **no
transitive dependencies** — pi's types are compile-time only (`import type`), enforced by
`test/packaging.test.ts`.
