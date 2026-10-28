---
"@alexkroman1/aai-runtime": patch
---

Two abort idioms in the runtime brought in line with the rest of the package. A
speculative LLM stream adopted by a turn now forwards the turn's abort REASON
into its own controller instead of aborting with none, so a reader of the
request's `signal.reason` sees the barge-in's, as it already does for a tool's
per-call controller. The header-WebSocket connect race is a plain
`Promise.withResolvers()` deferred rather than a private `EventEmitter` driven
through `p-event`; behaviour is unchanged.
