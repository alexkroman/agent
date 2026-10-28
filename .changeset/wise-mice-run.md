---
"@alexkroman1/aai-runtime": patch
---

Every refusal a tool call gets before it runs now says whether the identical
call will run if sent again: an argument precheck or a repeated failure is
refused again; a format-mirror refusal runs on the re-send.
