---
---

Add the `recap-desk` template (private `aai-templates` package — no published
package changes). It is the Temporal-patterns worked example, ported onto a
voice call: a saga whose compensation stack is unwound by journaled steps, a
bounded poll loop whose waits are durable `sleep`s, a `Promise.race` against a
patience timer, and the Query/Cancellation/one-run-per-caller trio spelled as
voice tools. The I/O is real throughout — AssemblyAI's batch transcription API
submits, polls and deletes — and both module docs record the two Temporal
behaviours that did not port (cancellation is not cooperative here, and a voice
turn cannot signal a run because `ctx.workflows` exposes no hook resume).
