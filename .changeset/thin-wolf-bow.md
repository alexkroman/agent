---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
"aai-studio-server": patch
---

Internal refactor, no behaviour change: aai-runtime's Logger and S2S config get their own modules (logger.ts, s2s-config.ts), the largest transport/session/journal factories are split into named units, and duplicated helpers (isPathInside, tracing env, isLogLine, conformance keys) now have one home; aai-server's SqlExec type moves to sql-exec.ts, and the studio route suites inject their fakes instead of module-mocking them.
