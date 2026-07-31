---
"aai-server": minor
---

Split the studio backend from the agent backend: AAI_SERVICE selects combined (default), agent (reverse-proxies the studio surface to STUDIO_UPSTREAM_URL, keeping one public origin for the preview iframe), or studio (standalone service). Cross-service sandbox invalidation via slug epochs in aai_platform.slug_epochs — deploy/delete/secret/storage mutations bump, resolveSandbox rebuilds resident sandboxes on mismatch, which also closes the pre-existing replica-to-replica deploy staleness.
