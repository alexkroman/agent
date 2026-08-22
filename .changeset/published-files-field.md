---
"@alexkroman1/aai": patch
"aai-templates": patch
---

Publish `dist` and nothing else. `@alexkroman1/aai` had no `files` field, and
`.npmignore` excludes only repo artifacts (`etc/`, `coverage/`, `.turbo/`,
`contracts/`) — so every tarball carried the whole `host/` and `sdk/` TypeScript
source and 219 test files: 961 entries, 2,049 kB packed, 7,632 kB unpacked,
against 209/505/1,476 now. Consumers were downloading the SDK's test suite.

`AGENT_GUIDE.md` and `skills/` stay (both ship deliberately); `CHANGELOG.md`
does not, matching `aai-ui` and `aai-cli`. Nothing supported breaks — every
`exports` target is under `dist`, and the `@dev/source` condition that points at
`.ts` source is activated only by this monorepo's own `customConditions`.

`published-files-gate.test.ts` is the guard: every publishable package declares
a non-empty `files`, and every `exports` target is covered by it. The two things
that should have caught this and did not are worth naming — the artifact-size
report compares against the PR base, so a package that has ALWAYS shipped its
source never trips a delta gate, and `publint` files it as a *suggestion*, which
`check:publint` passes over.
