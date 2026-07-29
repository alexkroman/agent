---
"aai-server": patch
---

Store/guest hardening: redeploy preserves platform-default KV (delete still wipes it), NDJSON per-line byte cap against hostile guests, fail-fast guest RPC on dead stdout, no-op secret deletes skip the sandbox restart, base64url input validation, single SafeKvKeySchema source, and dependency cleanup (drop nanoid and unused React type stubs).
