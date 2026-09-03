---
"@alexkroman1/aai-ui": minor
---

useWorkflowSubmit now remembers a run and picks it back up by default: it mints an opaque per-page correlation key into sessionStorage, records every run under it, and adopts that key's newest run on mount, so a reload lands back on the same result, progress log and controls instead of an empty form beside a live run nothing can name. Six of six page templates passed useRunKey() and recover: true to get this, and they now pass neither. A page that wants a different scope still passes key (an account's id, or useRunKey({ storage: "local" })), and recover: false opts the lookup out.
