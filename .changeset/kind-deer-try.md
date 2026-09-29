---
"@alexkroman1/aai": patch
---

`expectPromptBuiltinsDeclared` treats a custom tool named like a builtin (a `tools/text_me.ts` replacing `text_me`) as declaring it, and takes an optional `tools`. `commandedBuiltins` now finds single-word builtins (`think`, `calculate`, `remember`, `recall`) where a prompt NAMES them — in backticks, as "the calculate tool", or as the object of use/call/invoke — and not in prose such as "think before you answer".
