---
"@alexkroman1/aai-runtime": major
---

Retire the durable-workflow wake hint. The platform's delivery sweep IS the wake now: it claims due messages from a table with a slug and an available_at and brokers a sandbox to deliver them, which is the query the DevKit's own schema could not answer and the whole reason a per-app hint table existed. Removes createWakeHintPublisher, WakeHintOptions, WakeHintPublisher and WORKFLOW_WAKE_TABLE from /internal — a removal from a published subpath, hence major, though that subpath carries no capability contract by construction.
