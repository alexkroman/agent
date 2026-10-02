---
"@alexkroman1/aai": patch
---

`ProjectFiles.tools` (on `@alexkroman1/aai/testing`) spells out its type,
`Readonly<Record<string, unknown>>`, instead of naming `ToolModules`, a type no
testing capability owned. The type is the same, so nothing that compiled before
stops compiling.
