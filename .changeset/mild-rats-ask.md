---
"@alexkroman1/aai": minor
---

Add `stepFetchOk` to `@alexkroman1/aai/step-errors` — `stepFetch` plus the non-2xx branch three templates had each hand-rolled, carrying the far side's own error text into the message and leaving the retryable/terminal verdict with `toStepError`. Adds a `podcast-digest` template: a scheduled workflow app that transcribes new podcast episodes and posts a Slack digest on a repeating durable sleep.
