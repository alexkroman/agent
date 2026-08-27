---
"@alexkroman1/aai-runtime": minor
---

A deployed guest's durable-workflow world is now the platform's: journal, streams and queue all reached over HTTP, with only the DevKit's createQueueHandler kept locally. The platform world wins over a DATABASE_URL, so a workflow agent opens no database of its own for runs.
