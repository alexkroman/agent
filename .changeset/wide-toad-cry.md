---
"@alexkroman1/aai": patch
---

Answer a workflow input-validation failure with 400 rather than 500. A guest runs two copies of the SDK by design — the harness bundles one, the agent's runtime comes from its own bundle — so the route's `instanceof WorkflowRequestError` check was false across that seam and every caller mistake was rethrown as an opaque server error. The guard is a registered-symbol brand now, which crosses it.
