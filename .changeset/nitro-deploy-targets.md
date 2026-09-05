---
"@alexkroman1/aai-cli": minor
---

Deploy targets: adopt four properties from Nitro's presets.

- **`aai build` now prints the deploy command for every target**, and returns it
  (plus the output directory) on the result so `--json` sees both. `--target
  vercel` printed the directory it wrote and no command at all.
- **The Vercel routing table brackets `handle: filesystem`** with an
  `immutable` cache-control header for the content-hashed `/assets/` prefix and
  a CDN-level `404` for a miss under it, so hashed assets stop re-validating on
  every load and a stale bundle request stops costing a function invocation.
- **The function's Node major rounds UP** to the smallest version Vercel offers
  that is at least the one running the build, clamping at the newest. It
  rounded down, so a build on Node 23 deployed onto `nodejs22.x`.
- **The Deno entry drains on `SIGINT`/`SIGTERM`**, which only the Modal entry
  did — Deno Deploy stops a deployment on the same events, so a live call lost
  its socket rather than its session. Both entries now share one drain.

Vercel build-environment detection also reads `VERCEL_ENV` and `NOW_BUILDER`
alongside `VERCEL`.
