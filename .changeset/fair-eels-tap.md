---
"aai-server": minor
---

Extract the studio into its own package (aai-studio-server): aai-server is now the agent service plus the shared platform core, with wildcard TS exports for the sibling service. The combined entry moves to aai-studio-server; per-service Modal apps deploy independently, gated by changesets in CI.
