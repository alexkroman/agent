---
"@alexkroman1/aai": patch
---

Stop allocating per STT partial in pipeline turn-taking. `countWords` now scans instead of `split(/\s+/)`, and the barge-in gates use a new `hasMinWords`/`hasSpeech` pair that stops as soon as the threshold is met — partials arrive several times a second and grow with the utterance, so the old word array was garbage on a latency-sensitive path. `onSttPartial` also no longer counts the same partial twice.
