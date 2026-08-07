---
"@alexkroman1/aai": patch
---

An interrupted reply now records only the words the caller is estimated to have heard, and a reply cut before anything was audible records nothing at all (its tool steps still do). The false-interruption resume anchor reads the same cursor, and AssemblyAI TTS word timings make it word-accurate.
