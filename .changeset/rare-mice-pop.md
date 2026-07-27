---
"@alexkroman1/aai": patch
---

Stop allocating per STT partial in pipeline turn-taking. `countWords` now scans instead of `split(/\s+/)`, and the final-path barge-in gate uses a new `hasMinWords` that stops as soon as the threshold is met — partials arrive several times a second and grow with the utterance, so the old word array was garbage on a latency-sensitive path. The word helpers moved to `pipeline-text.ts`.

Also fix TTS text coalescing stranding speech across a tool call. Batching only ever deferred text that more text was coming for, but nothing released the buffer at a segment boundary, so a short unpunctuated fragment ("Sure, let me") held its tail for the whole tool-execution window — the caller heard the opening words, then dead air, since `holdPhrase` is suppressed once the model has spoken. The coalescer now exposes `boundary()`, called on `text-end` and before a tool call, which forwards the buffer and re-arms the immediate-first-chunk allowance so the post-tool reply's opening words are not batched either.
