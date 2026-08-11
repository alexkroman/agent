---
"@alexkroman1/aai": patch
---

A static-page app no longer needs a provider credential it never uses, and the workflow API reports a runtime it could not build instead of claiming the app declares no workflows. useWorkflowRun no longer restarts its poll when the caller rebuilds its client each render.
