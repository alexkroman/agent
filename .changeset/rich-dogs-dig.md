---
"@alexkroman1/aai": patch
---

Log a pipeline LLM stream failure as one compact line with its HTTP status, URL, and provider request id instead of letting the AI SDK dump the raw error object (three nested stack traces plus the whole request body) to the console.
