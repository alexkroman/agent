---
"@alexkroman1/aai": patch
---

Correct the `builtinTools` default in the docs, and make it checkable.

`DEFAULT_BUILTIN_TOOLS` has been empty for some time, but `AgentDef.builtinTools`
still described a four-tool "cognitive set" default — contradicting the
`BuiltinTool` doc in the same file, the SDK guide, and the scaffold guide
shipped into every `aai init` project, which marked four built-ins "on by
default". Unset enables none; `[]` and omitting the field mean the same thing.

Nothing could catch the drift: the constant was annotated `readonly
BuiltinTool[]`, which erased the type-level fact that it is empty, and its only
assertion was an `arrayContaining` spread that is vacuously true for an empty
array. It is now `as const satisfies` with an equality test.
