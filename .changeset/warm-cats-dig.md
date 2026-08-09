---
"aai-server": patch
---

Bound the shutdown teardown. createShutdownHandler armed its fallback timer only after onShutdown() settled, so the one deadline on shutdown covered waiting for connections to close and left sandbox teardown unbounded — and teardown is the half that hangs, since Sandbox.drain/shutdown reach a guest through the spawn's readiness promise (120s of boot budget). SANDBOX_TEARDOWN_READY_MS (5s, memoized per sandbox) caps that wait, and SHUTDOWN_TEARDOWN_TIMEOUT_MS (20s) is the general net over the untimed Modal control-plane calls beneath it.
