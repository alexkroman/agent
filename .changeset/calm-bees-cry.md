---
"@alexkroman1/aai-runtime": minor
---

Raise the workflow step-concurrency default from 3 to 16, measured against a guest rather than inherited from graphile-worker. A fan-out was capped at three whatever the body asked for, so a template's own measured width was inert. Sixteen is what a real libkrun microVM holds at Modal's guaranteed reservation (1 CPU / 1024 MB): a concurrent transcription segment costs 26.1 MB at 48 kHz stereo, putting sixteen at 576 MB of 982 MB usable. Also raises the workflow progress-poll default from 1s to 5s — two of those hooks on one run spend a page's entire per-IP request budget and contend with the upload for the same link.
