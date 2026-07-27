---
"@alexkroman1/aai": patch
---

Fix pipeline false-interruption recovery firing over a still-talking user, cap consecutive resumes, close the speaking edge when an utterance never commits, and keep a barge-in partial's caption from being blanked by the cancel that follows it.
