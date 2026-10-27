---
"@alexkroman1/aai-runtime": patch
---

A host-mode (relay) session now logs `Host builtin tool` for every builtin the
host runs itself, with the tool name and, for `think`, the thought (a character
count in production). The client only receives a `tool.called` for a tool it has
to run, so a relay harness such as tau2 had no record of whether the model used
`think` before a write.
