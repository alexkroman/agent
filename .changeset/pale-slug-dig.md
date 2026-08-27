---
"@alexkroman1/aai-runtime": minor
---

Bound platform-facing Postgres access so a network partition sheds load instead of hanging: createPostgresDb gains optional connectTimeoutSeconds and queryTimeoutMs (a client-side per-pooled-query deadline — the only bound that survives a silent partition, where a server statement_timeout's cancellation notice is blackholed too; reserved/advisory-lock connections are exempt). The self-hosting createServer also sets an explicit headers timeout and keep-alive timeout to reap slowloris connections on its public surface.
