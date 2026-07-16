---
"@alexkroman1/aai": patch
---

Harden connection-churn paths: cancel in-flight session start on disconnect, abort tool-call repair on interrupt, clean session maps on stop, release provider socket listeners, and cap S2S resume attempts.
