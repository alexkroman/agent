---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": patch
---

Stated defaults now match the constants, and a connection reset is classified by direction.

- **`minBargeInWords`' documented default is 1**, which it has been since 2026-09-09; its JSDoc, the docs site's tuning table and the authoring guide said 2. The docs table also gave `maxTurnSilenceMs` as 3000 (it is 3500), and the guide's `agent()` listing gave the endpointing pair as 560 / 1600 (it is 1600 / 3500). The claims that the default lets "yeah" and "mm-hmm" through are rewritten: any word can interrupt, and `interruptionMinDurationMs` is what filters a short backchannel. A new `check:defaults` gate holds every `@defaultValue`, the docs table and the guide to the constants' real values.
- **The workflow API reads `ECONNRESET` off the innermost `cause`.** A reset with no `syscall` (Node's inbound `aborted`) is the caller hanging up and is dropped; one naming a `syscall` (an outbound `fetch` or database socket) is a `503` with `Retry-After`, at any wrapping depth. A bare outbound reset used to be dropped as a hangup.
- **`sttPrompt` is the one STT steering input a pipeline sends** — recorded and pinned by a test; the leftover per-turn dialog `keyterms` plumbing, which nothing applied since v17, is removed from the runtime.
