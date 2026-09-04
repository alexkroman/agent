---
"@alexkroman1/aai-ui": major
---

useToolResult defaults its result to `unknown` rather than `any`, and useToolCallStart takes a type parameter for the tool's args. The result type is inferred at `tool()` and this hook is the one place a client reads it, so an `any` default discarded the inference exactly where it was wanted; the start hook had no type parameter at all, so args could not be checked even by a client that knew the shape.
