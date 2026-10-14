---
"@alexkroman1/aai-cli": patch
---

`aai dev --tunnel` now works for agents with a `client.tsx`: the tunnel's
hostname is added to Vite's `server.allowedHosts`, so requests through it (the
page, the API, and webhooks such as Twilio's) are no longer refused with
"Blocked request. This host is not allowed."
