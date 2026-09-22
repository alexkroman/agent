---
"@alexkroman1/aai-runtime": minor
---

Authenticate self-hosted voice sessions. `createRuntimeServer`, `createAgentServer` and `createHostServer` take an optional `auth` (`SessionAuthOptions`): a built-in HMAC session ticket (`createSessionToken` / `verifySessionToken`, or just `AAI_SESSION_SECRET` in the server env), your own `verify` callback, and an `allowedOrigins` list. The ticket rides the `Sec-WebSocket-Protocol` header as `aai.auth.<ticket>` (or `?token=`), is checked before the handshake, and a refused session is declined with a fatal error frame and close code 4401. A `?sessionId=` resume is only honoured for the identity that opened the session, or for a ticket minted with that `sessionId`. Off unless configured — existing servers behave exactly as before.
