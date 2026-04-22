---
"@alexkroman1/aai": patch
---

Simplify pipeline-session state management and parallelize provider open. Removes redundant PipelineState variable (equivalent to turnController != null), opens STT+TTS concurrently via Promise.allSettled (halves session-start latency), and cleans up either session if one open fails or the session aborts mid-open.
