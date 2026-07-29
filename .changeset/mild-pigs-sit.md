---
"@alexkroman1/aai": minor
---

Deployed agents accept ?host=1 WebSocket connections that override systemPrompt/greeting/tools, gated on the owner's API key (startHostSession gains an allowHost option so the platform can gate on ownership rather than AAI_ALLOW_HOST).
