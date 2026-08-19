---
"aai-server": patch
---

Refuse a workflow-upload window write under a slug no agent answers to.

`slugMw` validates a slug's shape and its reserved names, never its existence, so `PUT /:slug/uploads/:id/:offset` accepted bytes under any slug at all — measured against production, `PUT /no-such-agent-here/uploads/upl_x/0` answered 201 and stored `uploads/no-such-agent-here/upl_x/0`, and a DELETED agent's prefix stayed writable indefinitely. The route is deliberately unauthenticated, like `/client-config` beside it, and its own doc argued the worst an unrecorded write achieves is an orphan — which only holds if the number of prefixes is bounded, and it was not. Nothing reclaims them either: `aai-sweep-blob-gc` matches `name like 'blobs/%'`.

A write now costs one indexed column read (`getAgentVersion`) and answers the same 404 an unknown agent gets everywhere else. Reads are deliberately NOT gated: a read is the fan-out, so a lookup there is one query per window to establish what a miss already reports.

This is the strongest check available at this layer and not the one you would want — the upload record lives in the app's own database, which only the guest can reach, so the platform cannot ask whether an id was ever claimed. Orphans under a real agent's prefix are unchanged.
