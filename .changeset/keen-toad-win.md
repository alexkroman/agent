---
"aai-server": patch
---

Store jsonb columns as jsonb: the ::jsonb parameter cast made postgres.js double-encode every document, which broke all metadata stamps and blinded the orphan-preview sweep
