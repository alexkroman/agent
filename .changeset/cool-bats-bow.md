---
"aai-studio-client": patch
---

Studio gate screens never sit on an unexplained wait: the account and auth-config reads carry per-attempt deadlines, and a failed read shows "AssemblyAI Build is busy right now" with a Try again button instead of "Loading…" forever.
