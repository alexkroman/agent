---
"@alexkroman1/aai-runtime": minor
---

MCP tools now carry an `effect`, taken from the server's `readOnlyHint` by MCP's
own default: a tool is a write unless its server marks it read-only, so an
unannotated third-party tool gets the write gate, the ledger and the identifier
check.
