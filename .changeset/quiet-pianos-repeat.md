---
"aai-server": patch
---

Emit a workspace change event on `patch`, so the studio's Preview pane updates
under `pnpm dev:aai-server`.

`withWorkspaceEvents` — the dev/test decorator standing in for production's
`postgres_changes` stream — wrapped `put` and `delete` but not `patch`. Every
metadata stamp goes through `patch` (`stampWorkspaceMeta` is the only writer of
`previewSlug`/`previewHash`/`previewError`, `deployedSlug`/`deployedHash`, and
`databaseEnabled`), so in local dev a finished preview deploy pushed no
`project` frame at all. With no polling loop behind those streams, the Preview
pane sat on "Nothing to preview yet" / "Updating preview…" until the page was
reloaded — and a failed preview's error banner, a Publish, and the database
switch were silent the same way. Production was unaffected: it wraps nothing,
because the row's own UPDATE is what Realtime streams.

The studio SSE regression test modelled the preview stamp as a read-modify-write
rather than calling `stampWorkspaceMeta`, which is why it stayed green.
