---
"@alexkroman1/aai": patch
"aai-server": patch
---

Bound three guest resource bypasses found by adversarial testing: the coding tools' `grep` runs a model-supplied regex in a terminable worker (a catastrophic pattern no longer wedges the whole process), `run_code` caps the console output it keeps, and the studio's `download_to_workspace` stops reading a response at the file cap instead of buffering it whole.
