---
"@alexkroman1/aai": minor
---

Add an experimental Composio integration on `@alexkroman1/aai/experimental`: `composio()` (per-user tool-router sessions with a pluggable session store and once-on-404 recreation, `execute`, `listApps`, `connectLink`, `disconnect`, trigger lookup/upsert/delete, and `mcpServer()` for `mcpServers`/`stepMcp`), plus `composioWebhookRoute`, `composioTriggerText`, `ComposioTriggerEvent` and `ensureComposioWebhook`. Composio's error detail (message, failing fields, request id) is kept in every `HttpError`, and the API key is never in one.
