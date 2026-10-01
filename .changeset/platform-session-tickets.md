---
"@alexkroman1/aai-runtime": minor
"aai-server": minor
---

A deployed agent's voice session now opens only for a session ticket the platform minted. `GET /:slug/client-config` returns a `sessionToken` bound to one session (`Cache-Control: no-store`), signed with a key both sides derive from the sandbox's existing per-sandbox bearer, so no new credential reaches the guest, the agent env or the browser. The guest's `WS /websocket` and `WS /inbox` refuse an upgrade without a valid ticket (close 4401). The guest also accepts tickets signed with the author's own `AAI_SESSION_SECRET` when the agent env sets one.

To resume, a browser sends back the last ticket it was issued in the `aai-session-ticket` header. The broker then mints a fresh ticket for the same session, provided the old one is validly signed and no more than 12 hours past its expiry. A ticket from the previous deploy also counts, so a call survives a redeploy. Without the old ticket, the browser gets a new session: knowing a session id is no longer enough to resume it. The browser client stores that ticket next to the session id, so a page reload still resumes.

**Breaking change to resume rules:** a ticket bound to a session (`createSessionToken({ sessionId })`) now opens exactly that session. It resumes that session, or starts it under that id if nothing is there yet, whatever `?sessionId=` names. Previously such a ticket was refused unless it was resuming that session. The studio's API docs mention the ticket.
