---
"@alexkroman1/aai-runtime": minor
---

Drive a declared `agent({ dialogs })` from the session: session events reach the dialog, per-state deadlines fire, the active state's instruction reaches the model every turn, and three of its voice knobs take effect.

Events are offered to each dialog between the client send and the author's `events` hooks, so a hook reading `position()` sees the state the dialog moved TO. Deadlines run from the dialog's last move, which is what makes both a silence ladder (a self-transition on `@user-transcript.committed` restarts the window) and an abandonment deadline (nothing extends it) expressible without the runtime guessing. `bargeIn`, `toolChoice` and `temperature` are live on the pipeline, the latter two per STEP; `voice` and `keyterms` cannot take effect mid-session and warn at the first session rather than doing nothing quietly. Preemptive generation is disabled for a session whose dialogs vary the LLM knobs, since a speculation decides once whether it is free.
