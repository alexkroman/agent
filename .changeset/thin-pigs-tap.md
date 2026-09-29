---
"@alexkroman1/aai-runtime": patch
---

The `AAI_EVAL_REPEAT` summary now shows an UNSTABLE case's whole failure: the full assertion message (bounded), then a transcript of the failing try — each line said, each reply, each tool call with its arguments and result, and any request the eval network refused.
