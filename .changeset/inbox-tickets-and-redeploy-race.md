---
"@alexkroman1/aai-ui": minor
"aai-server": patch
---

The inbox socket now works on a server that requires session tickets. `createInbox` takes a `token` option that behaves like `VoiceSessionOptions.token`. `useInbox` fills it in from the new `session.identity.ticket()`: the session's own `token` if it has one, otherwise a fresh ticket from `client-config` (asked for again until a lookup shows the server issues none). Before this, a gated `aai dev` or self-hosted server refused the inbox socket.

The platform broker now mints each session ticket for the deploy version of the guest it actually routes the session to: the resident sandbox's own version, or the version a peer replica was found by. It no longer reads the version from the local slot or the agents row, which during a redeploy could name a different deploy, so the guest refused the session (4401).
