---
"@alexkroman1/aai-ui": minor
---

The browser client can present a session ticket. `createBrowserSession` and `mountClient()` take a `token` option — a string, or a getter asked on every connection attempt (the first, each reconnect and each resume) and told the session that attempt resumes — and send it in `Sec-WebSocket-Protocol` as `aai.auth.<ticket>` beside the plain `aai.session` protocol, which the server selects so the ticket is never echoed back. Without a `token`, a ticket the server's `client-config` issued (`sessionToken`, new on `ClientConfigResponse`) is used. `aai dev` with `AAI_SESSION_SECRET` set now mints one for the client it serves, instead of refusing it. `SESSION_PROTOCOL` and `SESSION_AUTH_PROTOCOL_PREFIX` are on `@alexkroman1/aai/protocol`, so both ends spell them once.
