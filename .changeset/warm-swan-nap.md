---
"@alexkroman1/aai-ui": patch
---

`useWorkflowStream` refuses a submission whose payload still carries a `File` instead of starting a run over it. A File serializes to `{}`, so it arrived as an empty object and the workflow rejected its own input — reported in production as `recording: Invalid input` from a page whose file picker was working.
