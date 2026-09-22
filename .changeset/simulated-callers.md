---
"@alexkroman1/aai-runtime": minor
---

Add simulated callers and a model-graded judge to `@alexkroman1/aai-runtime/eval`. `simulateCall(session, { caller: { persona, goal }, llm })` has a second model play the user until it calls `end_call` or `maxTurns` runs out, and reports every turn plus metrics (turns, duration, reply latency, tool calls). `judgeCall(call, { criteria, llm })` rules on each criterion and computes the verdict itself. `describeEval`/`describeTextEval` cases get both as `simulate()` and `judge()`, scripted in a keyless run via the new `stubCaller`/`stubJudge` case options, with `callerLlm`/`judgeLlm` suite options for the live models.
