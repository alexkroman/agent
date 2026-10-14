---
"@alexkroman1/aai": minor
"aai-server": minor
---

Outbound calls connect on the managed platform: `stepPlaceCall` now dials Twilio
with a webhook (`<agentUrl>/phone?…`) instead of inline TwiML, the platform's
`/:slug/phone` and a self-hosted server's new HTTP `/phone` pass the call's
parameters into the stream, and `agentUrl` defaults to the agent's own public
URL. `stubPlaceCall` records `webhookUrl` (was `streamUrl`) and takes
`publicUrl`. `outbound-call-agent` no longer needs `CALLER_AGENT_URL`.
