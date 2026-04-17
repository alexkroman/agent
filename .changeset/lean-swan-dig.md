---
"@alexkroman1/aai-cli": patch
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
---

Republish after the 1.2.2 release workflow failed (broken lockfile under `pnpm/action-setup@v6`). Also: `aai init` now skips deploy when `pnpm install` fails, so users see the real install error instead of a cryptic Rolldown `@alexkroman1/aai` resolution failure.
