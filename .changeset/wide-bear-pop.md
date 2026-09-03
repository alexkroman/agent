---
"@alexkroman1/aai-cli": patch
---

Template specs assert invariants that survive customization: renaming an agent, swapping a provider stage, or adding a tool or workflow no longer fails a shipped test (and so no longer blocks `aai build`).
