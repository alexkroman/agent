---
"@alexkroman1/aai-ui": major
"@alexkroman1/aai-runtime": patch
"aai-studio-client": patch
---

**Breaking (nominally): `@alexkroman1/aai-ui/default-client/*` is removed.** It
had no consumer in any form — not one import specifier in the repo, the
templates, the scaffold, or any README — because every real consumer reaches
those files by filesystem path through `./package.json` (`client-dir.ts`,
`aai-server/transport-websocket.ts`). `files: ["dist"]` still ships them, so
nothing that worked stops working. `aai-studio-client`'s `./dist/*` goes for the
same reason: both of its consumers `require.resolve` the manifest and join
`"dist"` themselves.

Also widens `check:attw`. `aai-ui` pinned `--entrypoints .`, which silently
excluded `./client-dir` — a typed, contracted subpath — and `aai-runtime`
inherited the same pin. `aai-ui` now uses `--exclude-entrypoints styles.css`
(a CSS entry point has no type declarations, which is the only reason the pin
existed) and `aai-runtime` drops it entirely, so a NEW subpath defaults into
being checked instead of out.
