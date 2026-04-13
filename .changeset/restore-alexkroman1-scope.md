---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-cli": patch
"aai-server": patch
---

Force all libraries and the server to publish/deploy after the 1.0.1
release failure. Restores the `@alexkroman1/` scope on publishable
packages so npm accepts the publish, and bumps `aai-server` to trigger
the Fly.io deploy job in the release workflow.
