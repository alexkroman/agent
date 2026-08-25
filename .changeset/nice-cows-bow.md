---
"aai-server": patch
---

Wire the durable-run wake sweep to the per-app databases its hints live in. The orchestrator passed only `adminDb`, and `startWorkflowWakeSweep` needs `appDb` too since the hints moved into each app's own database — so the sweep returned a no-op and reported it at `debug`, which `consoleLogger` drops unless `AAI_DEBUG=1`. No durable run whose sandbox had exited was ever woken. The not-started branch is now three branches: absent together stays `debug` (local dev), exactly one absent is an `error` naming it, and the interval-0 kill switch is `info`.
