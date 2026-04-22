---
"@alexkroman1/aai": minor
---

Internal: manifests now classify session mode (`s2s` | `pipeline`) at parse time, and expose optional `stt`, `llm`, and `tts` fields on the `Manifest` type. Groundwork for upcoming pluggable provider support — no user-visible behavior change yet.
