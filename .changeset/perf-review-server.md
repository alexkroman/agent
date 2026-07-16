---
"aai-server": minor
---

Performance pass on the platform server: guest fetch requests use guest-generated ids so rejection notifications can no longer race the RPC ack (previously a disallowed-host fetch stalled 30s and leaked a pending entry), the warm sandbox pool recovers from spawn failures with exponential-backoff cooldown instead of disabling itself permanently, worker bundles are TTL-cached like manifests, the guest NDJSON line splitter is linear instead of quadratic on large bundle loads, PBKDF2 hashing is skipped for requests to nonexistent slugs, tool-call RPC responses no longer round-trip unused session state, NDJSON writes respect stream backpressure (host drain-aware queue, guest full-write loop), keyed slug locks free their map entries when released (p-lock dependency removed), custom-event size caps measure UTF-8 bytes, and deploy uploads accept gzip-compressed bodies with a decompressed-size limit.
