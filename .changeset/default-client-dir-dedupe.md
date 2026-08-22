---
"aai-server": patch
---

Resolve the default client through `@alexkroman1/aai-ui/client-dir` instead of
two more copies of the three-line `require.resolve` dance. `aai-ui`'s guide
already claimed this consolidation had happened; `transport-websocket.ts` and
`orchestrator.test.ts` were the copies it missed. Behaviour gains one thing: a
missing install now says so, naming `@alexkroman1/aai-ui`, where the inlined
copy threw `MODULE_NOT_FOUND` for a path nobody wrote and surfaced as a server
answering 404 for `/`. The memo the local copy carried is
`createCachedDirReader`'s already.
