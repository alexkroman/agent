---
"aai-server": patch
"aai-studio-server": patch
---

Test tooling only: package test scripts select slow tiers by a uniform src/** glob, and aai-server's test helpers are split by domain behind the unchanged aai-server/test-utils subpath. No runtime behaviour changes.
