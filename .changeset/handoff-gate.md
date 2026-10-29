---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

A tool can declare `effect: "handoff"` (`ToolEffect` is now
`"read" | "write" | "handoff"`) to mark a transfer that ends the agent's part of
the call. In a voice pipeline such a tool runs only when one of the caller's
last two turns asks for a person (an English phrase list), or when the model
calls it again after a further caller turn. Otherwise the model is told the
transfer was NOT made and how to keep helping. Agents that declare no handoff
are unchanged. The roster's `handoff` speaker switch carries no effect and is
not gated. On tau2-bench retail, sims that transferred passed 17% of the time
against 69% for those that did not, and 20 of 24 transfers were in failed sims.
Replayed at those 24 transfers, the gate ran 9 of 12 samples at the expected
transfers. Unwanted transfers fell from 22 of 60 to 9, all after the caller had
asked for a person.
