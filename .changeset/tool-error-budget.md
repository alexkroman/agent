---
"@alexkroman1/aai-runtime": patch
---

A voice turn whose tool calls keep failing now stops calling tools and answers
the caller. Within one turn, the next step is forced to `toolChoice: "none"` as
soon as the model repeats a call (same tool, same arguments) that already failed
in that turn, or once three tool results in that turn have failed. A failure is
a tool error, a `{"error": ...}` result, or a result string starting with
`Error`. Before, the model could keep retrying until `maxSteps` while the caller
heard only filler. Each forced answer logs `tool-error budget spent; forcing an
answer` once per turn. `createTextAgent` is unchanged.
