---
"@alexkroman1/aai": minor
"aai-server": minor
---

The AssemblyAI STT's default maxTurnSilenceMs (the ceiling that force-ends a
turn regardless of content) drops from 3500 to 1500 ms. A tau2-bench retail
comparison found the semantic endpointer often not committing in noise: callers
re-prompted 162 times, against 24 for a stack with a forced commit. Agents that
relied on the longer pause tolerance for hesitant callers can restore it with
turnTaking: { maxSilenceMs: 3500 }.
