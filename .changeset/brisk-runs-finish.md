---
"@alexkroman1/aai": patch
---

A workflow run no longer needs a visitor to finish.

A deployed guest measured "does anybody need me" by its live WebSocket session count — and an `agent({ page: "static" })` app has none by construction, so a guest whose entire job was workflow runs looked permanently idle. The five-minute idle timer fired mid-run every time, and the run then waited out a 120-second lease plus an inbound request before it could continue: the platform manufacturing the very failure the journal exists to survive.

`WorkflowEngine.busy()` is the second input to that decision — true while a run is executing here, or while a near-term wake timer is armed — and the guest's idle controller now defers on it. Verified against a real Postgres: a 12-second run held its sandbox open under a 3-second idle window with zero sessions, and the guest still reclaimed itself 3 seconds after the run completed.

Two properties are deliberate. It defers the IDLE exit and **not a drain**, because a drain retires the sandbox for a redeploy, every run is resumable on the replacement, and holding a blue-green handover open for a long run would stall the deploy to save work that is not lost. And it is false for a sleeper past `MAX_WAKE_TIMER_MS`, since holding a billed container open for a six-hour `ctx.sleep` is exactly what suspending the run releases it to avoid — that case still needs an external wake.
