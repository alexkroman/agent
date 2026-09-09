---
"aai-docs": patch
---

Cut compiler scaffolding out of two documentation examples.

`more/background-jobs.md`'s first fence was the largest in the docs at 33
lines, and 9 of them were two stub function bodies returning fake segments so
the fence would compile. The prose above it promises "a workflow body is an
ordinary exported async function of its input and a `WorkflowContext`", and a
reader had to work out for themselves that the bottom third of the example was
not part of that. They are `declare function` lines now — the technique the
sibling fence twenty lines further down already uses — which drops the fence to
26 lines and reads as "assume these exist" rather than as code to study. The
one real teaching point that had been buried inside a stub body, that a step is
where the whole Node runtime is available and the body is not, moves up to the
`ctx.step` call site where it is visible.

`build/agent.md`'s slot declaration used `() => ({ items: [] as string[] })` —
the cast `build/state.md` explicitly names as the thing not to do, in a comment
reading "The return annotation is what types the value — no `[] as Item[]`
cast". It is the annotation form now, at the same line count. One page naming
an anti-pattern while a sibling page ships it is the same drift as the
`sky`/`conditions` split between `build/tools.md` and the scaffold's own
`get_weather`.

Neither example opts out of the gate to get shorter: `pnpm check:doc-examples`
still compiles 363 fences, and the `no-check` budget is untouched at 115.
