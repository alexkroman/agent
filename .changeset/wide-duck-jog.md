---
"@alexkroman1/aai": patch
---

Every published subpath of @alexkroman1/aai now resolves to an explicit re-export facade rather than to an implementation file, so an implementation module can be split without moving a published entry point and a new export joins the public surface only deliberately. No published name or signature changes.
