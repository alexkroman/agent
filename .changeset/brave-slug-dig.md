---
"@alexkroman1/aai": patch
---

Auto-resume AssemblyAI S2S sessions after transient WebSocket closes (1005, 1006, 1011, 3005) using session.resume within the 30s server window. Drops the in-flight reply via onCancelled so the session unblocks; falls back to the existing 'connection' error on fatal codes (1008/3006/3007/3008/3009) or when resume fails.
