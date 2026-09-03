---
"@alexkroman1/aai-cli": patch
---

aai build now gates on the project's whole test suite rather than agent.test.ts alone, and a declared-but-empty .env value is dropped instead of being handed to a provider as "" (which silently defeated the host-credential fallback). aai test gained the --all flag its own incomplete-run failure recommends.
