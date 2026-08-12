---
"@alexkroman1/aai": patch
---

The workflow journal's schema is migrated through an ordered ledger rather than re-created on every boot. Every create-if-not-exists ran per engine, which is idempotent but not free: Postgres raises a NOTICE per no-op into a log the guest relays to the platform.
