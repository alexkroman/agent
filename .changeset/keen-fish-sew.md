---
"@alexkroman1/aai": patch
"aai-server": patch
"aai-studio-server": patch
---

Replace truthiness-guarded conditional spreads with explicit presence checks
(omitUndefined, != null, === true), so an empty-string body forwarded to a guest
is no longer dropped; guard-invariants rule 22 is now enforced at zero.
