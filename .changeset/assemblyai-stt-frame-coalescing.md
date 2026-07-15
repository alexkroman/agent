---
"@alexkroman1/aai": patch
---

Fix AssemblyAI streaming STT rejecting telephony audio with "Input Duration Violation". The provider now coalesces inbound PCM into 50–1000 ms frames (buffering ~100 ms, capping at 1000 ms, and flushing a ≥50 ms tail on close) before forwarding to AssemblyAI, which requires each streaming audio frame to fall in that window. Clients that stream standard 20 ms RTP frames (e.g. the tau2 harness) now work unchanged.
