---
"@alexkroman1/aai-cli": patch
---

Pay down escape-hatch and conditional-spread debt: a typed fake session socket in the guest harness replaces eight `as never` casts and lets `lazyRuntime` drop its `as unknown as WebSocket`, `handleNotification` now takes the unvalidated frame shape it actually defends against, and nineteen truthiness-guarded conditional spreads over optional identifiers become `omitUndefined` — which also makes a session resume pass `resumeFrom` on the same test the runtime logs `resumed` with.
