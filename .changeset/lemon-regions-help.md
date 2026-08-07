---
---

Enable deny-all RLS on the aai_platform tables as defense in depth, and guard
it with three static assertions no external linter would make. Migration +
private package (aai-server) only.
