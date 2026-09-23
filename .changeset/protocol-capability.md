---
"@alexkroman1/aai": patch
---

`RestoredToolCall` (on `@alexkroman1/aai/protocol`) is now documented as public API rather than `@internal`, matching `RestoredToolCallSchema`, which it is inferred from. It rides the wire inside `history.restored`, so a custom client reads exactly this shape. The `/protocol` subpath is now covered by the versioned API contracts as the `aai:protocol` capability. There is no runtime change.
