---
"@alexkroman1/aai": minor
---

Add an agent log surface: a bounded ring in the guest, `GET /:slug/logs`, a studio Logs pane, and `aai logs`.

`aai` gains `createLogBuffer` on `/runtime` — the cursor-indexed ring both ends of the wire derive from. The guest tees its own stdout/stderr into it and serves `GET /manage/logs`; the platform reads that and answers `GET /:slug/logs` without booting a sandbox. The session event log is append-only to the app role now, so `ctx.db` can no longer delete an agent's own audit trail, and a discarded session's events are reclaimed by the retention sweep rather than by the runtime.
