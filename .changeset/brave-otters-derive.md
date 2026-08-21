---
"@alexkroman1/aai": minor
---

Add `derivedFlow()`, and an optional `invariant` on `flow()`.

A `flow()` stores its position in a slot of its own, which makes it a second source of truth beside the data it is about — held in step by convention, every tool moving both. The cost is not a crash: a stale position produces a refusal that reads correct, naming a real state and quoting its real instruction, so the model apologizes and retries something that cannot work. solo-rpg shipped exactly that bug, where a save taken with a roll standing came back refusing a legal burn.

`derivedFlow(machine, slot, locate)` computes the position from the slot instead, so there is nothing to keep in step. `locate` is a total, pure function of the data — testable with no session, no context and no tool call — the body's own write is the transition (no `send`, `sendFrom` or `reset`), and no XState actor is ever started. Four of the five flow templates convert: solo-rpg, retail, travel-concierge and plan-and-execute.

`FlowOptions.invariant` is for the case that genuinely cannot derive, where the position carries history the data does not. It asserts the half that is a function of the data and refuses a call that finds them disagreeing, naming both facts rather than producing the plausible-looking refusal; `flow.check(ctx)` runs it on demand so a spec can assert agreement at the seam that breaks it. dispatch-center keeps a stored flow and declares one.
