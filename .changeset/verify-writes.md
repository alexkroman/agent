---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

New opt-in pipeline safeguard: `agent({ writes: { verify: true } })` checks each
tool declared as a write (`annotations: { readOnlyHint: false }`) with a
separate model call before it runs, asking whether the call does exactly what
the caller asked for and agreed to, on the records as fetched. A specific
mismatch, quoting the caller or citing a tool result, is handed back to the
model instead of running the write; the same call made again runs, and a timeout
or failed check lets the write through. On a 114-task tau2 retail run, 35 of 61
missed writes were wrong choices over records the agent had already fetched, and
33 unrequested writes went through. Off by default while measured.
