---
"@alexkroman1/aai-runtime": minor
---

Budget conversation history in tokens everywhere and retire the 200-message cap. What a pipeline step sends is bounded only by the per-step token budget against the model's context window (an unknown window is now budgeted as the smallest window the gateway catalog carries instead of being left untrimmed); what a session remembers is bounded for memory in tokens too, at twice the largest request budget, so retention can never remove a message a request would send. `DEFAULT_MAX_HISTORY` is removed from `@alexkroman1/aai/internal`; `MAX_CLIENT_MESSAGES` (200) remains as the display bound on a `history.restored` frame and the browser snapshot. The runtime's `prepareStep` concerns now register by stage into one `composePreparers` pipeline whose order is fixed in one place, enforced by guard-invariants rule 35.
