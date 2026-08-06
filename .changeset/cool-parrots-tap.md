---
---

Halve the `as unknown as` double-casts under `packages/` (210 -> 105) by
replacing repeated per-call-site casts with typed seams, and add the pattern
to the escape-hatch ratchet so the count can only go down from here.

Test-infrastructure and tooling only — no shipped behaviour changes.
