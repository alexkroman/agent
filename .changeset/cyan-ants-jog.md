---
"@alexkroman1/aai": major
---

BREAKING: the root export no longer carries defaults and budgets. Import them from `@alexkroman1/aai/limits`, which now barrels every one — the ~88 in `constants.ts` plus the six workflow limits, `MAX_DB_RESULT_ROWS` and `MAX_SLUG_LENGTH`. The platform slug contract (`RESERVED_SLUGS`, `VALID_SLUG_RE`, `PREVIEW_SLUG_SUFFIX`, `MAX_SLUG_LENGTH`) moves to `@alexkroman1/aai/utils`, its documented home, and the two thrown-message strings (`STORAGE_DISABLED_MESSAGE`, `WORKFLOWS_UNAVAILABLE_MESSAGE`) to `@alexkroman1/aai/internal`. Five names stay on the root because they are not budgets: `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_GREETING`, `ASSEMBLYAI_S2S_KIND`, `ASSEMBLYAI_S2S_API_KEY_ENV`, `TERMINAL_WORKFLOW_STATUSES`. The root goes from 133 runtime names to 32.
