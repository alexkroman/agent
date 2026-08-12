---
"@alexkroman1/aai": minor
---

A tool's context and a workflow's context now share a named base, `AgentContext` — `env`, `db`, `generate`, `signal` — so a helper typed against it is callable from either. `ToolContext` and `WorkflowContext` extend it; neither loses a field.
