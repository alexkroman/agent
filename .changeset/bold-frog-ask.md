---
"aai-server": minor
---

Per-tenant database caps (role connection limit 4, best-effort temp_file_limit 64MB) and a database locator per app: app-db:<slug> now records the cluster URL, provisioning places new apps deterministically across APP_DB_URLS clusters (cellular sharding), and openAppDb follows the stored locator.
