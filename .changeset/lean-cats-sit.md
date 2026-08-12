---
"@alexkroman1/aai-cli": minor
---

Add aai workflow list/runs/show/cancel/retry. A durable run outlives every surface that can show it, and the only alternative was a hand-built curl needing the platform origin and the published slug. It talks to the agent's own brokered API with --token rather than the caller's API key, which authorizes nothing there.
