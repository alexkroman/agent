---
"@alexkroman1/aai": minor
---

Add createKeyedLock/withLock to the public SDK: a per-key async serializer for agents whose tools mutate shared ctx.state, which the LLM loop runs concurrently. Exported from the root and /utils.
