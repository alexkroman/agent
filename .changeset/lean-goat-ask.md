---
"aai-server": patch
---

Server review fixes: studio chat abort no longer leaks sandboxes, edit_file fuzzy matches map back to the original text, per-scope studio rate limiting, host-mode upgrades skip sandbox spawn, request-body size caps, graceful shutdown closes sockets, redeploy preserves platform-default KV, NDJSON line-length cap, plus test and simplification cleanups.
