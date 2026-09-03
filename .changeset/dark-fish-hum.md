---
"@alexkroman1/aai": patch
---

Bound turbo's task concurrency on every fan-out test door, and take biome 2.5.12.

`pnpm test` and five sibling scripts ran `turbo run <task>` with no TURBO_CONCURRENCY, so turbo's default of 10 tasks each took vitest's full `cores - 1` worker budget — ~40 processes on 4 cores. The two halves of that budget are one mechanism and only bound the machine when the variable is set, and only `scripts/check.mjs` set it. A/B on one commit: unbounded times out three aai-cli bundler and dev-server specs, bounded passes all 16 tasks.

biome moves to ^2.5.12 under the release-age quarantine's one exemption. 2.5.9-2.5.11 report an already-awaited `await pTimeout(…)` as a floating promise across nine call sites; 2.5.12 fixes that and also retires the suppression the same defect had already cost at 2.5.8, lowering the escape-hatch baseline to 124.
