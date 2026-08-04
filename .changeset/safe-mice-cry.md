---
"@alexkroman1/aai": patch
"aai-studio-server": patch
"aai-studio-client": patch
"aai-server": patch
---

Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
