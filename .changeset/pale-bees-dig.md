---
"aai-server": patch
---

Grant service_role SELECT on the Realtime-watched aai_platform tables so filtered postgres_changes subscriptions stop failing with 'invalid column for filter'
