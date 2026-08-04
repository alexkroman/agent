---
"@alexkroman1/aai": patch
---

Add `quietDdlNotices` to `createPostgresDb`, filtering the benign `already exists, skipping` notices that idempotent bootstrap DDL raises. The driver's default handler dumps each one as a multi-line object, which buries real errors in the platform log.
