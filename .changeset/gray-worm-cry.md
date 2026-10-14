---
"aai-server": patch
---

Outbound calls pass Twilio signature verification: Modal's proxy unquotes the
webhook query before it reaches `/:slug/phone`, so the platform now also
verifies against the query re-encoded the way `stepPlaceCall` built it.
