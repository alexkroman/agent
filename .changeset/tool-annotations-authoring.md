---
"@alexkroman1/aai": minor
---

An authored tool can now declare what it does to the world:
`tool({ ..., annotations: { readOnlyHint: false } })` marks a write, and the
pipeline then runs it only on a caller turn that did not start while the agent
was talking. The field is carried from `ToolDef` to the wire `ToolSchema`
(through `tool()` and session-slot tools alike). The SDK's own coding tools
`write_file`, `edit_file` and `delete_file` are marked.
