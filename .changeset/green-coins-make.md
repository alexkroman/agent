---
---

Add the `transcription-desk` template (private `aai-templates` package — no
published package changes). It is the fan-out worked example for durable
workflows: a step set whose width comes from a journaled step result, batched
`Promise.all` concurrency, and the module doc explaining why the Workflow
DevKit's issue-order step correlation rules out a work-stealing pool.
