---
"@alexkroman1/aai": patch
---

Filter the Postgres notices an IF NOT EXISTS raises. The workflow store ensures its schema on every boot and an agent doing the same for its own table adds one per run, so postgres.js's default handler printed six-line objects into a log the guest relays to the platform. Filtered on SQLSTATE (42P07/42710) rather than by silencing onnotice, so a notice nobody asked for still reports.
