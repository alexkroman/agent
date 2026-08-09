---
"aai-server": patch
---

Resync resident sandboxes when the agents change stream rejoins. subscribe() only sends the join and realtime-js rejoins after any socket drop, so changes in either window reach nobody — and since this stream is the single mover of resident sandboxes, nothing later noticed: a deploy during a drop left the replica serving superseded code and a delete left it answering for a deleted agent, until the guest happened to self-exit on idle. watchAgents now takes a slug-less onResync handler, and watchAgentInvalidation answers it by re-running the same per-slug reconcile over every resident in the slot cache.
