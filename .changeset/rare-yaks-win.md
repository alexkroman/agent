---
"@alexkroman1/aai": minor
---

Add `isRecord` to `@alexkroman1/aai/utils` — a type predicate narrowing an unknown to `Record<string, unknown>`, so the `typeof v === "object" && v !== null` check no longer needs a follow-up cast to read a field. Arrays are excluded.
