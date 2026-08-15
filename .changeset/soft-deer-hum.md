---
"@alexkroman1/aai": minor
---

One sleep, not six: sleep(ms, { signal, unref }) on @alexkroman1/aai/internal replaces six spellings across five packages at 22 call sites. The families differed in whether vi.useFakeTimers() could drive them — the global setTimeout can be faked, node:timers/promises cannot — so the spelling silently decided whether a poll loop was testable, and one caller had already grown an injectable seam to work around it. unref is now opt-in rather than a shared default, which surfaced a shutdown grace that could skip its own drains. Also escapes a raw NUL byte in host/workflow-notify.ts that made the file binary to git grep, exempting it from every gate in the repo.
