---
"@alexkroman1/aai": patch
---

Remove the S2S transcript.agent.delta accumulator: the event is documented but not implemented by the service, so the fallback could never fire. Records the measured behaviour instead — transcript.agent is omitted for both replies of a tool-call turn.
