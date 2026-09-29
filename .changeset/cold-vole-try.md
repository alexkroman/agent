---
"@alexkroman1/aai-runtime": minor
---

A tool's `endSession(ctx)` now takes effect in an eval session: by default the reply finishes (so the goodbye is captured), then the session stops as a real connection's does and `onSessionEnd` fires. `EvalTurn.endedSession` and `EvalSession.ended` report it, `say()` into an ended session rejects, `sayAll` stops after the ending turn, and a simulated call stops with the new `endedBy: "agent"` (`aai-runtime:eval-simulate` epoch 2; epoch 1 retained).
