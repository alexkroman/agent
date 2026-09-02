---
"@alexkroman1/aai-cli": patch
---

Report the two bundler-config invariants in `buildWorker` as named `InvariantViolation`s rather than generic errors, so a Vite output shape this module's own config makes impossible is distinguishable from a build failure a user can act on.
