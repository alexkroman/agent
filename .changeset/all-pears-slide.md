---
---

Add `retention.test.ts`: a per-table retention verdict for every `aai_platform`
table, derived from the migrations. Twelve are pruned by time; the five that are
not carry a checked reason. Documented in `aai-server/SCHEMA-CLAUDE.md`.
