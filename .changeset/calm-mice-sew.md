---
"aai-server": minor
---

Stateless server: move cross-replica coordination into Supabase Postgres — per-slug deploy/delete/secret/storage mutations now serialize through a lease-based lock in aai_platform.slug_locks, and studio rate limits live in aai_platform.studio_rate_limits so they hold across replicas.
