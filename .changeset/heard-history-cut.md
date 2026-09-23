---
"@alexkroman1/aai-runtime": patch
---

Pipeline mode now records only what the caller heard when a barge-in cuts a reply that had already been committed to history — during the TTS drain, in the client's playback tail, or while a follow-up reply was queued behind it. The reply is rewritten to its heard prefix marked `[interrupted]` (or dropped if nothing was heard), with its tool calls and results kept, so the model no longer believes it delivered information the caller never heard.
