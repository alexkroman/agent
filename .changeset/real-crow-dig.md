---
"@alexkroman1/aai-runtime": patch
---

Cut a batched upload part claim from three record round trips and eight probe rounds to one read, one write, and probes that run alongside them.
