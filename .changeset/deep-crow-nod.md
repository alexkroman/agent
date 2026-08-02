---
"aai-guest": patch
---

Consolidate aai-guest internals: one shared child-process runner (runCapped) replaces five hand-rolled spawn helpers, one bearer-auth module serves both authenticated surfaces, and the per-tool 120s deadline now wraps the merged studio tool set (web, project, and design tools included). Parallelize workspace snapshot/materialize/sync I/O and make grep read only glob-matching files.
