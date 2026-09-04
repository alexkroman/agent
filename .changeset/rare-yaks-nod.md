---
"@alexkroman1/aai": minor
---

Recover the message a record KEY schema wrote. Zod nests a failed key's own issues one level down under `issues`, so `formatSchemaIssues` reported `mcpServers.my-docs: Invalid key in record` and dropped the grammar the schema spells out; it now appends the nested cause while keeping the parent, which is the only thing that says KEY rather than value. `StandardSchemaIssue` gains an optional `issues` field alongside `errors`, and `withMcpTools`' doc no longer promises a throw its own name pre-filtering makes unreachable.
