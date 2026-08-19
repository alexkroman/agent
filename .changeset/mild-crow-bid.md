---
"@alexkroman1/aai": patch
"aai-server": patch
"aai-studio-server": patch
---

Fix four production errors from an hour of Modal logs: a 30s proxy deadline that aborted healthy uploads (27 x 503), a parallel-upload part that treated a retryable 503 as a refusal, a 5xx whose cause was never logged, and an aborted request logged as an agent failure.
