---
"@alexkroman1/aai": minor
---

Redeploys now hand over blue-green: the agents-row change event boots the
new deploy's sandbox and waits for its readiness before detaching the old
resident, so a redeploy never leaves an empty slot and the next caller pays
no cold start; old sessions drain in the background as before. The warm
sandbox pool is deleted entirely (production always ran with it disabled):
every spawn — agent, studio, inspect — boots directly from the published
content-addressed harness snapshot image through one code path, and every
sandbox is tagged with its real identity at creation. Modal sandbox memory
snapshots slot into this single spawn path once the JS SDK exposes them.
