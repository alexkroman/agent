---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`stepDelegate` — a whole tool loop from inside a workflow step, and two templates stop hand-rolling one.

`stepGenerate` was the one-shot a step already had; the gap beside it was the loop. A step is handed no `ToolContext`, so `ctx.delegate` was unreachable there and a workflow that needed a model to search-read-search hand-rolled it: an action schema for the model to pick from, a counter for the budget, a sentence telling it to answer once the budget was spent, and a branch for the turn where it named an action and filled in none of its fields. `stepDelegate(subagent, { task })` is the same `createSubagentRunner` `ctx.delegate` runs on, bound to a sessionless parent bag — a published `Symbol.for` slot rather than an import, because `ToolLoopAgent` may not ride into the agent bundle. `stubStepDelegate` and `installStubStepDelegate` drive one in a spec; an unpublished slot throws rather than answering emptily, since there is no degraded version of running a model loop.

`research-workflow`'s `investigate` deletes 82 lines of loop and helpers for it, and its second model call went too — `expectedOutput` compresses where the raw material already is (the file nets 44 code lines lighter; the rest is the researcher, its `cite` tool, and reading the run's cost off `toolCalls`). `plan-and-execute`'s `executeStep` is the same conversion through `ctx.delegate`, which its tool had all along; its executor gained a `read` tool, closing a gap its own prompt had left open ("search once, read what comes back", with no way to read).
