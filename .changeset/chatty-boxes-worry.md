---
---

Fix two race conditions in the studio's event streams and preview queue, found
by randomized interleaving tests (`studio-concurrency-fuzz.test.ts`).

The SSE routes read their row before subscribing to its change stream, so a
change landing in the gap was lost with nothing left to correct it. They now
subscribe first and send the initial frame through the same push chain, and a
Supabase Realtime (re)join fires its watchers — closing both the join round trip
and every socket-reconnect outage.

Preview jobs enqueued by a coding-agent turn or a project open carried no
`userId`, so a redelivery to any other replica found no credential and archived
the job: the preview silently never landed. The preview origin is now built once
and threaded through the session broker.

Only private packages changed, so this note is informational.
