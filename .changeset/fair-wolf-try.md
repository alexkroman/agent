---
"aai-server": patch
---

Give the durable-workflow queue's NOTIFY listener its own session-mode connection. It was subscribing through the transaction-mode pooler, where a LISTEN cannot be held: the subscription established without error, received nothing, and the only symptom was every step-to-step hop paying the sweep's poll interval again.
